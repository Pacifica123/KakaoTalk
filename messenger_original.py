#!/usr/bin/env python3
"""
Minimalist Relay Messenger – single‑file MVP
Run:
  python messenger.py server --host 0.0.0.0 --port 9000
  python messenger.py client --host SERVER_IP --port 9000 --name alice
"""

import argparse
import asyncio
import gzip
import json
import logging
import os
import struct
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, Tuple

# ----------------------------------------------------------------------
# Configuration constants
# ----------------------------------------------------------------------
MAX_HEADER_SIZE = 1 * 1024 * 1024          # 1 MiB
MAX_USERNAME_LEN = 64
MAX_MESSAGE_SIZE = 256 * 1024 * 1024      # 256 MiB
MAX_PACKET_SIZE = MAX_MESSAGE_SIZE + 1024 * 1024  # header + body margin
COMPRESSION_THRESHOLD = 64 * 1024         # 64 KiB

# ----------------------------------------------------------------------
# Helper: packet encoder / decoder
# ----------------------------------------------------------------------
class PacketProtocol:
    @staticmethod
    def _validate_header(header: Dict[str, Any]) -> None:
        if not isinstance(header, dict):
            raise ValueError("header must be a dict")
        # common fields validation
        typ = header.get("type")
        if typ not in {"hello", "hello_ok", "message", "list",
                       "users", "ping", "pong", "error"}:
            raise ValueError(f"unknown packet type: {typ}")

    @staticmethod
    def encode_packet(header: Dict[str, Any], body: bytes = b"") -> bytes:
        """Return bytes ready to be written to a TCP stream."""
        PacketProtocol._validate_header(header)
        header_json = json.dumps(header, ensure_ascii=False).encode("utf-8")
        if len(header_json) > MAX_HEADER_SIZE:
            raise ValueError("header too large")
        if len(body) > MAX_MESSAGE_SIZE:
            raise ValueError("body too large")
        # 4‑byte big‑endian length of header
        packet = struct.pack(">I", len(header_json)) + header_json + body
        if len(packet) > MAX_PACKET_SIZE:
            raise ValueError("packet exceeds max size")
        return packet

    @staticmethod
    async def read_exact(reader: asyncio.StreamReader, n: int) -> bytes:
        data = await reader.readexactly(n)
        return data

    @staticmethod
    async def decode_packet(reader: asyncio.StreamReader) -> Tuple[Dict[str, Any], bytes]:
        """Read one packet from the stream."""
        # read 4‑byte header length
        try:
            raw_len = await PacketProtocol.read_exact(reader, 4)
        except asyncio.IncompleteReadError:
            raise ConnectionError("connection closed while reading header size")
        (header_len,) = struct.unpack(">I", raw_len)
        if header_len > MAX_HEADER_SIZE:
            raise ValueError("header length exceeds limit")

        header_bytes = await PacketProtocol.read_exact(reader, header_len)
        try:
            header = json.loads(header_bytes.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON header: {exc}") from exc

        body_len = header.get("text_length", 0)
        if body_len:
            if body_len > MAX_MESSAGE_SIZE:
                raise ValueError("declared body length exceeds limit")
            body = await PacketProtocol.read_exact(reader, body_len)
        else:
            body = b""
        return header, body

# ----------------------------------------------------------------------
# Server implementation
# ----------------------------------------------------------------------
class RelayServer:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.clients: Dict[str, Tuple[asyncio.StreamReader, asyncio.StreamWriter]] = {}
        self.logger = logging.getLogger("RelayServer")

    async def start(self) -> None:
        server = await asyncio.start_server(self._handle_client, self.host, self.port)
        addr = server.sockets[0].getsockname()
        self.logger.info(f"Server listening on {addr}")
        async with server:
            await server.serve_forever()

    async def _handle_client(self,
                             reader: asyncio.StreamReader,
                             writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        self.logger.info(f"Incoming connection from {peer}")

        try:
            # 1. expect hello packet
            header, _ = await PacketProtocol.decode_packet(reader)
            if header.get("type") != "hello":
                await self._send_error(writer, "expected hello")
                writer.close()
                await writer.wait_closed()
                return

            name = header.get("name", "")
            if not isinstance(name, str) or not (1 <= len(name) <= MAX_USERNAME_LEN):
                await self._send_error(writer, "invalid username")
                writer.close()
                await writer.wait_closed()
                return

            if name in self.clients:
                await self._send_error(writer, "username already taken")
                writer.close()
                await writer.wait_closed()
                return

            # register client
            self.clients[name] = (reader, writer)
            await self._send_packet(writer, {"type": "hello_ok", "name": name})
            self.logger.info(f"Registered client '{name}'")

            # main loop for this client
            while True:
                header, body = await PacketProtocol.decode_packet(reader)
                await self._process_packet(name, header, body)

        except (ConnectionError, asyncio.IncompleteReadError):
            self.logger.info(f"Client {peer} disconnected")
        except Exception as exc:
            self.logger.exception(f"Error handling client {peer}: {exc}")

        finally:
            # cleanup
            await self._unregister(name)

    async def _unregister(self, name: str) -> None:
        client = self.clients.pop(name, None)
        if client:
            _, writer = client
            writer.close()
            await writer.wait_closed()
            self.logger.info(f"Unregistered client '{name}'")

    async def _process_packet(self, sender: str, header: Dict[str, Any], body: bytes) -> None:
        typ = header["type"]
        if typ == "message":
            await self._forward_message(sender, header, body)
        elif typ == "list":
            await self._send_users(sender)
        elif typ == "ping":
            await self._send_packet(self.clients[sender][1], {"type": "pong"})
        else:
            await self._send_error(self.clients[sender][1], f"unsupported packet type {typ}")

    async def _forward_message(self, sender: str, header: Dict[str, Any], body: bytes) -> None:
        to_user = header.get("to")
        if not isinstance(to_user, str):
            await self._send_error(self.clients[sender][1], "invalid recipient")
            return
        if to_user not in self.clients:
            await self._send_error(self.clients[sender][1], f"user '{to_user}' offline")
            return

        # server overwrites sender name, reuses provided id
        new_header = {
            "type": "message",
            "id": header.get("id", str(uuid.uuid4())),
            "from": sender,
            "to": to_user,
            "text_length": header.get("text_length", 0),
            "compressed": header.get("compressed", False),
        }
        writer = self.clients[to_user][1]
        await self._send_packet(writer, new_header, body)

    async def _send_users(self, requester: str) -> None:
        users = list(self.clients.keys())
        header = {"type": "users", "users": users}
        writer = self.clients[requester][1]
        await self._send_packet(writer, header)

    async def _send_error(self, writer: asyncio.StreamWriter, msg: str) -> None:
        await self._send_packet(writer, {"type": "error", "message": msg})

    async def _send_packet(self,
                           writer: asyncio.StreamWriter,
                           header: Dict[str, Any],
                           body: bytes = b"") -> None:
        packet = PacketProtocol.encode_packet(header, body)
        # protect against concurrent writes
        async with asyncio.Lock():
            writer.write(packet)
            await writer.drain()

# ----------------------------------------------------------------------
# Client implementation (core, UI‑agnostic)
# ----------------------------------------------------------------------
class MessengerClient:
    def __init__(self, host: str, port: int, name: str):
        self.host = host
        self.port = port
        self.name = name
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.incoming_task: asyncio.Task | None = None
        self.logger = logging.getLogger("MessengerClient")
        self._lock = asyncio.Lock()   # serialize writes

    async def connect(self) -> None:
        while True:
            try:
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(self.host, self.port), timeout=5
                )
                await self._send_hello()
                header, _ = await PacketProtocol.decode_packet(self.reader)
                if header.get("type") != "hello_ok":
                    raise ConnectionError("handshake failed")
                self.logger.info(f"Connected as {self.name}")
                # start background receive loop
                self.incoming_task = asyncio.create_task(self._recv_loop())
                return
            except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
                self.logger.warning(f"Connection failed: {exc}, retrying in 3 s")
                await asyncio.sleep(3)

    async def _send_hello(self) -> None:
        hdr = {"type": "hello", "name": self.name}
        await self._send_packet(hdr)

    async def _send_packet(self,
                           header: Dict[str, Any],
                           body: bytes = b"") -> None:
        if not self.writer:
            raise ConnectionError("not connected")
        packet = PacketProtocol.encode_packet(header, body)
        async with self._lock:
            self.writer.write(packet)
            await self.writer.drain()

    async def send_message(self,
                           to: str,
                           text: str,
                           compress: bool = False) -> None:
        data = text.encode("utf-8")
        if compress and len(data) > COMPRESSION_THRESHOLD:
            data = gzip.compress(data)
            compressed = True
        else:
            compressed = False

        hdr = {
            "type": "message",
            "id": str(uuid.uuid4()),
            "to": to,
            "text_length": len(data),
            "compressed": compressed,
        }
        await self._send_packet(hdr, data)

    async def request_user_list(self) -> None:
        await self._send_packet({"type": "list"})

    async def ping(self) -> None:
        await self._send_packet({"type": "ping"})

    async def _recv_loop(self) -> None:
        try:
            while True:
                header, body = await PacketProtocol.decode_packet(self.reader)
                await self._handle_server_packet(header, body)
        except (ConnectionError, asyncio.IncompleteReadError):
            self.logger.info("Server connection lost")
        finally:
            await self._cleanup()

    async def _handle_server_packet(self, header: Dict[str, Any], body: bytes) -> None:
        typ = header["type"]
        if typ == "message":
            sender = header.get("from", "<unknown>")
            text = body
            if header.get("compressed"):
                try:
                    text = gzip.decompress(body)
                except OSError:
                    self.logger.error("Failed to decompress message")
                    return
            try:
                txt = text.decode("utf-8")
            except UnicodeDecodeError:
                txt = "<binary data>"
            print(f"\n[{sender}] {txt}\n> ", end="", flush=True)
        elif typ == "users":
            users = header.get("users", [])
            print(f"\nOnline: {', '.join(users)}\n> ", end="", flush=True)
        elif typ == "pong":
            pass  # could log latency
        elif typ == "error":
            print(f"\n[SERVER ERROR] {header.get('message')}\n> ", end="", flush=True)
        else:
            self.logger.warning(f"Unhandled packet type: {typ}")

    async def reconnect(self) -> None:
        await self._cleanup()
        await self.connect()

    async def _cleanup(self) -> None:
        if self.incoming_task:
            self.incoming_task.cancel()
            try:
                await self.incoming_task
            except asyncio.CancelledError:
                pass
            self.incoming_task = None
        if self.writer:
            self.writer.close()
            await self.writer.wait_closed()
            self.writer = None
            self.reader = None

    async def close(self) -> None:
        await self._cleanup()

# ----------------------------------------------------------------------
# Simple console UI (runs only in client mode)
# ----------------------------------------------------------------------
class ConsoleUI:
    HELP_TEXT = """Commands:
/users               – show online users
/use NAME            – set recipient
/send FILE           – send file content to current recipient
/reconnect           – reconnect to server
/quit                – exit
"""

    def __init__(self, client: MessengerClient):
        self.client = client
        self.recipient: str | None = None

    async def run(self) -> None:
        print(self.HELP_TEXT)
        while True:
            try:
                line = await self._aioconsole_input("> ")
            except (EOFError, KeyboardInterrupt):
                break

            if not line:
                continue
            if line.startswith("/"):
                await self._handle_command(line.strip())
            else:
                if not self.recipient:
                    print("Set a recipient first with /use NAME")
                else:
                    await self.client.send_message(self.recipient, line)

    async def _handle_command(self, cmd: str) -> None:
        parts = cmd.split(maxsplit=1)
        name = parts[0]
        arg = parts[1] if len(parts) > 1 else ""

        if name == "/users":
            await self.client.request_user_list()
        elif name == "/use":
            if arg:
                self.recipient = arg
                print(f"Recipient set to {self.recipient}")
            else:
                print("Usage: /use USERNAME")
        elif name == "/send":
            if not self.recipient:
                print("Set recipient first")
                return
            path = Path(arg)
            if not path.is_file():
                print("File not found")
                return
            text = path.read_text(encoding="utf-8")
            await self.client.send_message(self.recipient, text, compress=True)
            print(f"Sent file '{path.name}'")
        elif name == "/reconnect":
            await self.client.reconnect()
        elif name == "/quit":
            await self.client.close()
            sys.exit(0)
        else:
            print("Unknown command. Type /users, /use, /send, /reconnect, /quit")

    async def _aioconsole_input(self, prompt: str) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: input(prompt))

# ----------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------
def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Minimalist Relay Messenger")
    sub = parser.add_subparsers(dest="mode", required=True)

    srv = sub.add_parser("server", help="run relay server")
    srv.add_argument("--host", default="0.0.0.0")
    srv.add_argument("--port", type=int, default=9000)

    cli = sub.add_parser("client", help="run interactive client")
    cli.add_argument("--host", required=True, help="server IP")
    cli.add_argument("--port", type=int, default=9000)
    cli.add_argument("--name", required=True, help="your username (max 64 chars)")

    return parser.parse_args()

async def main() -> None:
    configure_logging()
    args = parse_args()

    if args.mode == "server":
        server = RelayServer(args.host, args.port)
        await server.start()
    else:  # client
        client = MessengerClient(args.host, args.port, args.name)
        await client.connect()
        ui = ConsoleUI(client)
        await ui.run()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
