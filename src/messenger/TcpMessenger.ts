import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import TcpSocket from 'react-native-tcp-socket';
import { encodePacket, PacketDecoder, PacketHeader } from './Protocol';

export type MessengerState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export type NetworkError = {
  stage: 'tcp-connect' | 'handshake' | 'protocol' | 'socket' | 'send';
  code?: string;
  message: string;
  details: string;
};

type SocketLike = ReturnType<typeof TcpSocket.createConnection>;

function normalizeError(error: unknown): { code?: string; message: string } {
  const e = error as { code?: string; message?: string };
  return {
    code: e?.code,
    message: e?.message || String(error)
  };
}

export function explainNetworkError(error: unknown, stage: NetworkError['stage']): NetworkError {
  const { code, message } = normalizeError(error);
  const c = String(code || '').toUpperCase();
  const text = message.toLowerCase();

  if (stage === 'tcp-connect') {
    if (c.includes('ECONNREFUSED')) {
      return { stage, code, message, details: 'TCP достиг IP, но порт отверг соединение. Сервер не слушает этот порт или firewall его отклоняет.' };
    }
    if (c.includes('ETIMEDOUT') || c.includes('TIMEOUT') || text.includes('timed out')) {
      return { stage, code, message, details: 'Ответа от IP:порт не пришло за таймаут. Чаще всего: неверный IP/порт, разные сети, Wi‑Fi isolation, firewall или сервер недоступен.' };
    }
    if (c.includes('EHOSTUNREACH') || c.includes('ENETUNREACH')) {
      return { stage, code, message, details: 'Android не имеет маршрута до этого адреса. Проверь Wi‑Fi, подсеть и не включён ли VPN/изоляция клиентов.' };
    }
    if (c.includes('ECONNRESET') || c.includes('ENETRESET')) {
      return { stage, code, message, details: 'Соединение было принято, но удалённая сторона его сбросила.' };
    }
    if (c.includes('EAI_AGAIN') || c.includes('EAI_NONAME') || text.includes('unknown host')) {
      return { stage, code, message, details: 'Не удалось разрешить имя хоста. Для локальной сети используй IPv4-адрес сервера, например 192.168.1.20.' };
    }
  }

  if (stage === 'handshake') {
    return { stage, code, message, details: 'TCP-соединение есть, но сервер не ответил ожидаемым hello_ok. Проверь, что запущен именно этот Python-сервер и совпадает порт.' };
  }

  if (stage === 'protocol') {
    return { stage, code, message, details: 'Соединение установлено, но пришёл пакет, который клиент не смог разобрать по протоколу исходного messenger.py.' };
  }

  return { stage, code, message, details: 'Нативный сокет сообщил ошибку. Смотри code/message выше — они оставлены без маскировки.' };
}

export class TcpMessenger {
  private socket: SocketLike | null = null;
  private decoder = new PacketDecoder();
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((error: unknown) => void) | null = null;
  private state: MessengerState = 'idle';
  private connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly name: string,
    private readonly callbacks: {
      onState?: (state: MessengerState) => void;
      onPacket?: (header: PacketHeader, body: Buffer) => void;
      onError?: (error: NetworkError) => void;
      onClose?: () => void;
    } = {}
  ) {}

  getState(): MessengerState {
    return this.state;
  }

  async connect(): Promise<void> {
    await this.close();
    this.decoder.reset();
    this.setState('connecting');

    const options = {
      host: this.host,
      port: this.port,
      connectTimeout: 5000,
      ...(Platform.OS === 'android' ? { interface: 'wifi' as const, reuseAddress: true } : {})
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

      const fail = (error: unknown, stage: NetworkError['stage']) => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        const normalized = (error as NetworkError)?.stage
          ? error as NetworkError
          : explainNetworkError(error, stage);
        this.callbacks.onError?.(normalized);
        if (!settled) {
          settled = true;
          reject(normalized);
        }
      };

      const socket = TcpSocket.createConnection(options, () => {
        this.connected = true;
        this.setState('connected');

        // Install handshake handlers before sending hello: a LAN server can reply immediately.
        this.handshakeResolve = () => {
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        this.handshakeReject = (error) => fail(error, 'handshake');

        try {
          this.sendPacket({ type: 'hello', name: this.name });
          handshakeTimer = setTimeout(() => {
            fail(new Error('hello_ok timeout after 5000 ms'), 'handshake');
            socket.destroy();
          }, 5000);
        } catch (error) {
          fail(error, 'send');
          socket.destroy();
        }
      });

      this.socket = socket;

      socket.on('data', (data) => {
        try {
          const packets = this.decoder.push(Buffer.from(data));
          for (const packet of packets) {
            if (!settled && packet.header.type === 'hello_ok') {
              this.handshakeResolve?.();
              this.handshakeResolve = null;
              this.handshakeReject = null;
            }
            this.callbacks.onPacket?.(packet.header, packet.body);
          }
        } catch (error) {
          fail(error, 'protocol');
          socket.destroy();
        }
      });

      socket.on('error', (error) => {
        const stage: NetworkError['stage'] = settled || this.connected ? 'socket' : 'tcp-connect';
        fail(error, stage);
        this.connected = false;
        this.setState('error');
      });

      socket.on('close', () => {
        if (!settled) fail(new Error('socket closed before handshake completed'), this.connected ? 'handshake' : 'tcp-connect');
        this.connected = false;
        this.socket = null;
        if (this.state !== 'error') this.setState('closed');
        this.callbacks.onClose?.();
      });
    }).catch(async (error) => {
      this.connected = false;
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      this.handshakeResolve = null;
      this.handshakeReject = null;
      this.setState('error');
      throw error;
    });
  }

  private sendPacket(header: PacketHeader, body: Buffer = Buffer.alloc(0)): void {
    if (!this.socket || !this.connected) throw new Error('not connected');
    const packet = encodePacket(header, body);
    this.socket.write(packet);
  }

  sendMessage(to: string, text: string): void {
    const body = Buffer.from(text, 'utf8');
    try {
      this.sendPacket({
        type: 'message',
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        to,
        text_length: body.length,
        compressed: false
      }, body);
    } catch (error) {
      const normalized = explainNetworkError(error, 'send');
      this.callbacks.onError?.(normalized);
      throw normalized;
    }
  }

  requestUsers(): void {
    this.sendPacket({ type: 'list' });
  }

  ping(): void {
    this.sendPacket({ type: 'ping' });
  }

  async close(): Promise<void> {
    this.handshakeResolve = null;
    this.handshakeReject = null;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.destroy();
    this.setState('closed');
  }

  private setState(state: MessengerState): void {
    this.state = state;
    this.callbacks.onState?.(state);
  }
}
