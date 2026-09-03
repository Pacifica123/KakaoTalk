import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Buffer } from 'buffer';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Network from 'expo-network';
import { TcpMessenger, explainNetworkError, MessengerState, NetworkError } from './src/messenger/TcpMessenger';
import type { PacketHeader } from './src/messenger/Protocol';

const DEFAULT_PORT = '9000';

type ChatMessage = { id: string; from: string; text: string; mine?: boolean };

function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.button, disabled && styles.buttonDisabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function fieldStatus(value: string): string {
  return value.trim() ? '' : 'required';
}

export default function App() {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [name, setName] = useState('android');
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [state, setState] = useState<MessengerState>('idle');
  const [users, setUsers] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<NetworkError | null>(null);
  const [networkInfo, setNetworkInfo] = useState('network: checking...');
  const [diagnostic, setDiagnostic] = useState<string>('');
  const messenger = useRef<TcpMessenger | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const connected = state === 'connected';
  const canConnect = Boolean(host.trim() && port.trim() && name.trim());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [ip, network] = await Promise.all([
          Network.getIpAddressAsync(),
          Network.getNetworkStateAsync()
        ]);
        if (!alive) return;
        setNetworkInfo(`device: ${ip} / ${network.type}${network.isConnected ? '' : ' / OFFLINE'}`);
      } catch (e) {
        if (alive) setNetworkInfo(`network info failed: ${String(e)}`);
      }
    })();
    return () => { alive = false; };
  }, []);

  const addError = useCallback((next: NetworkError) => {
    setError(next);
    setDiagnostic(`${next.code ? `[${next.code}] ` : ''}${next.message}\n${next.details}`);
  }, []);

  const handlePacket = useCallback((header: PacketHeader, body: Buffer) => {
    if (header.type === 'users') {
      const nextUsers = Array.isArray(header.users) ? header.users.filter((u): u is string => typeof u === 'string') : [];
      setUsers(nextUsers);
      if (!recipient && nextUsers.length) {
        const firstOther = nextUsers.find((u) => u !== name);
        if (firstOther) setRecipient(firstOther);
      }
      return;
    }

    if (header.type === 'message') {
      const from = typeof header.from === 'string' ? header.from : '<unknown>';
      if (header.compressed) {
        setMessages((current) => [...current, {
          id: `${Date.now()}-compressed`,
          from,
          text: '[compressed message: not decoded by this minimal client]'
        }]);
        return;
      }
      const decoded = body.toString('utf8');
      setMessages((current) => [...current, {
        id: typeof header.id === 'string' ? header.id : `${Date.now()}-${Math.random()}`,
        from,
        text: decoded
      }]);
      return;
    }

    if (header.type === 'error') {
      const message = typeof header.message === 'string' ? header.message : 'server returned error';
      addError({ stage: 'protocol', message, details: 'Ответ пришёл от Python relay server.' });
    }
  }, [addError, name, recipient]);

  const connect = useCallback(async () => {
    const trimmedHost = host.trim();
    const trimmedName = name.trim();
    const numericPort = Number(port);
    setError(null);
    setDiagnostic('');
    setMessages([]);

    if (!trimmedHost || !trimmedName || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      const local = explainNetworkError(new Error('Invalid host/name/port'), 'tcp-connect');
      local.message = `Invalid settings: host="${trimmedHost}" port="${port}" name="${trimmedName}"`;
      local.details = 'Host должен быть IPv4/hostname, порт 1..65535, имя непустое.';
      addError(local);
      return;
    }

    const client = new TcpMessenger(trimmedHost, numericPort, trimmedName, {
      onState: setState,
      onPacket: handlePacket,
      onError: addError,
      onClose: () => setState((current) => current === 'error' ? 'error' : 'closed')
    });
    messenger.current = client;

    try {
      await client.connect();
      client.requestUsers();
    } catch (e) {
      if ((e as NetworkError)?.stage) addError(e as NetworkError);
      else addError(explainNetworkError(e, 'tcp-connect'));
    }
  }, [addError, handlePacket, host, name, port]);

  const disconnect = useCallback(async () => {
    await messenger.current?.close();
    messenger.current = null;
    setUsers([]);
    setState('closed');
  }, []);

  const send = useCallback(() => {
    const to = recipient.trim();
    const value = text.trimEnd();
    if (!to || !value || !messenger.current || !connected) return;
    try {
      messenger.current.sendMessage(to, value);
      setMessages((current) => [...current, {
        id: `${Date.now()}-${Math.random()}`,
        from: name,
        text: value,
        mine: true
      }]);
      setText('');
    } catch (e) {
      addError((e as NetworkError)?.stage ? e as NetworkError : explainNetworkError(e, 'send'));
    }
  }, [addError, connected, name, recipient, text]);

  const headerStatus = useMemo(() => {
    if (state === 'connecting') return 'CONNECTING';
    if (state === 'connected') return 'CONNECTED';
    if (state === 'error') return 'ERROR';
    if (state === 'closed') return 'CLOSED';
    return 'IDLE';
  }, [state]);

  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <View style={styles.webMessage}>
          <Text style={styles.title}>Relay Chat</Text>
          <Text style={styles.muted}>Web build is intentionally disabled for the TCP client.</Text>
          <Text style={styles.muted}>Use the Android APK from the GitHub/EAS build.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.headerRow}>
            <Text style={styles.title}>Relay Chat</Text>
            <Text style={styles.status}>{headerStatus}</Text>
          </View>
          <Text style={styles.muted}>{networkInfo}</Text>
          <Text style={styles.muted}>Android transport: native TCP / Wi‑Fi interface / 5s connect timeout</Text>

          <View style={styles.card}>
            <Text style={styles.section}>SERVER</Text>
            <TextInput style={styles.input} value={host} onChangeText={setHost} placeholder="192.168.1.20" placeholderTextColor="#666" autoCapitalize="none" />
            <TextInput style={styles.input} value={port} onChangeText={setPort} placeholder="9000" placeholderTextColor="#666" keyboardType="number-pad" />
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="android" placeholderTextColor="#666" autoCapitalize="none" />
            <View style={styles.row}>
              {!connected ? (
                <Button title={state === 'connecting' ? 'CONNECTING...' : 'CONNECT'} onPress={connect} disabled={!canConnect || state === 'connecting'} />
              ) : (
                <Button title="DISCONNECT" onPress={disconnect} />
              )}
              <Button title="REFRESH USERS" onPress={() => messenger.current?.requestUsers()} disabled={!connected} />
            </View>
          </View>

          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>CONNECTION ERROR</Text>
              <Text style={styles.mono}>{diagnostic}</Text>
              <Text style={styles.muted}>The app does not auto-retry. Fix the shown cause, then press CONNECT.</Text>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.section}>ONLINE USERS</Text>
            {users.length === 0 ? <Text style={styles.muted}>none / not loaded</Text> : null}
            <View style={styles.userWrap}>
              {users.map((user) => (
                <Pressable key={user} style={[styles.user, recipient === user && styles.userSelected]} onPress={() => user !== name && setRecipient(user)}>
                  <Text style={styles.userText}>{user}{user === name ? ' (you)' : ''}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={styles.input} value={recipient} onChangeText={setRecipient} placeholder="recipient" placeholderTextColor="#666" autoCapitalize="none" editable={connected} />
          </View>

          <View style={styles.card}>
            <Text style={styles.section}>MESSAGES</Text>
            <ScrollView ref={scrollRef} style={styles.messages} nestedScrollEnabled onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
              {messages.length === 0 ? <Text style={styles.muted}>no messages</Text> : messages.map((message) => (
                <View key={message.id} style={styles.message}>
                  <Text style={styles.messageMeta}>{message.mine ? 'you' : message.from}</Text>
                  <Text style={styles.messageText}>{message.text}</Text>
                </View>
              ))}
            </ScrollView>
            <TextInput
              style={[styles.input, styles.messageInput]}
              value={text}
              onChangeText={setText}
              placeholder="message"
              placeholderTextColor="#666"
              editable={connected && Boolean(recipient.trim())}
              multiline
              onSubmitEditing={send}
            />
            <Button title="SEND" onPress={send} disabled={!connected || !recipient.trim() || !text.trim()} />
          </View>

          <Text style={styles.muted}>Protocol: identical framing to messenger.py. Compressed incoming payloads are reported, not silently mangled.</Text>
          <Text style={styles.muted}>Pydroid diagnosis: this build deliberately exposes the native socket error instead of hiding it behind an endless retry loop.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  flex: { flex: 1 },
  container: { padding: 16, gap: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#f4f4f4', fontSize: 24, fontWeight: '700' },
  status: { color: '#a0a0a0', fontSize: 12, fontWeight: '700' },
  muted: { color: '#777', fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: '#111', borderWidth: 1, borderColor: '#222', borderRadius: 8, padding: 12, gap: 8 },
  errorCard: { backgroundColor: '#190d0d', borderWidth: 1, borderColor: '#522222', borderRadius: 8, padding: 12, gap: 8 },
  errorTitle: { color: '#ff7d7d', fontWeight: '800', fontSize: 12 },
  section: { color: '#999', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  input: { backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: '#292929', borderRadius: 6, color: '#f5f5f5', paddingHorizontal: 10, paddingVertical: 9, minHeight: 42 },
  messageInput: { minHeight: 72, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  button: { backgroundColor: '#f0f0f0', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 6 },
  buttonDisabled: { opacity: 0.35 },
  buttonText: { color: '#090909', fontWeight: '800', fontSize: 12 },
  userWrap: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  user: { borderWidth: 1, borderColor: '#292929', paddingHorizontal: 9, paddingVertical: 7, borderRadius: 5 },
  userSelected: { borderColor: '#eee' },
  userText: { color: '#ddd', fontSize: 12 },
  messages: { maxHeight: 330, minHeight: 100 },
  message: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1b1b1b' },
  messageMeta: { color: '#888', fontSize: 11, marginBottom: 3 },
  messageText: { color: '#eee', fontSize: 14, lineHeight: 20 },
  mono: { color: '#d7d7d7', fontFamily: Platform.OS === 'android' ? 'monospace' : undefined, fontSize: 12, lineHeight: 18 },
  webMessage: { padding: 20, gap: 10 }
});
