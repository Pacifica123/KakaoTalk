import { Buffer } from 'buffer';

export const MAX_HEADER_SIZE = 1 * 1024 * 1024;
export const MAX_MESSAGE_SIZE = 256 * 1024 * 1024;
export const MAX_PACKET_SIZE = MAX_MESSAGE_SIZE + MAX_HEADER_SIZE;

export type PacketHeader = Record<string, unknown> & {
  type: string;
  text_length?: number;
};

export type Packet = {
  header: PacketHeader;
  body: Buffer;
};

const PACKET_TYPES = new Set([
  'hello',
  'hello_ok',
  'message',
  'list',
  'users',
  'ping',
  'pong',
  'error'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodePacket(header: PacketHeader, body: Buffer = Buffer.alloc(0)): Buffer {
  if (!isRecord(header) || typeof header.type !== 'string' || !PACKET_TYPES.has(header.type)) {
    throw new Error(`unknown packet type: ${String(header?.type)}`);
  }

  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerJson.length > MAX_HEADER_SIZE) throw new Error('header too large');
  if (body.length > MAX_MESSAGE_SIZE) throw new Error('body too large');

  const packet = Buffer.allocUnsafe(4 + headerJson.length + body.length);
  packet.writeUInt32BE(headerJson.length, 0);
  headerJson.copy(packet, 4);
  body.copy(packet, 4 + headerJson.length);

  if (packet.length > MAX_PACKET_SIZE) throw new Error('packet exceeds max size');
  return packet;
}

export class PacketDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Packet[] {
    if (chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const packets: Packet[] = [];
    while (true) {
      if (this.buffer.length < 4) break;

      const headerLength = this.buffer.readUInt32BE(0);
      if (headerLength > MAX_HEADER_SIZE) {
        throw new Error(`header length ${headerLength} exceeds ${MAX_HEADER_SIZE}`);
      }
      if (this.buffer.length < 4 + headerLength) break;

      let header: PacketHeader;
      try {
        header = JSON.parse(this.buffer.subarray(4, 4 + headerLength).toString('utf8')) as PacketHeader;
      } catch (error) {
        throw new Error(`invalid JSON header: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!isRecord(header) || typeof header.type !== 'string' || !PACKET_TYPES.has(header.type)) {
        throw new Error(`unknown packet type: ${String(header?.type)}`);
      }

      const declaredBodyLength = header.text_length ?? 0;
      if (!Number.isInteger(declaredBodyLength) || declaredBodyLength < 0) {
        throw new Error(`invalid body length: ${String(declaredBodyLength)}`);
      }
      if (declaredBodyLength > MAX_MESSAGE_SIZE) {
        throw new Error(`declared body length ${declaredBodyLength} exceeds ${MAX_MESSAGE_SIZE}`);
      }

      const totalLength = 4 + headerLength + declaredBodyLength;
      if (totalLength > MAX_PACKET_SIZE) throw new Error('packet exceeds max size');
      if (this.buffer.length < totalLength) break;

      packets.push({
        header,
        body: Buffer.from(this.buffer.subarray(4 + headerLength, totalLength))
      });
      this.buffer = Buffer.from(this.buffer.subarray(totalLength));
    }

    return packets;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
