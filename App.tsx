import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  Platform,
  ScrollView,
  TextInput,
} from 'react-native';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from 'firebase/auth';
import {
  getDatabase,
  ref,
  set,
  onValue,
  remove,
  onDisconnect,
} from 'firebase/database';

// ---------------- Firebase Setup ----------------
const firebaseConfig = {
  apiKey: "AIzaSyCK7AV4BHrj0o_sPhstug4ph59adWv1eb0",
  authDomain: "file-transfer-app-9f7bd.firebaseapp.com",
  databaseURL: "https://file-transfer-app-9f7bd-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "file-transfer-app-9f7bd",
  storageBucket: "file-transfer-app-9f7bd.firebasestorage.app",
  messagingSenderId: "31409683737",
  appId: "1:31409683737:web:4b48323ff521d3d4619988",
  measurementId: "G-SDRWCQRRTW",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const isWeb = Platform.OS === 'web';

interface Device {
  id: string;
  email: string;
  deviceName: string;
  lastSeen: number;
}

interface FileTransfer {
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
}

const WebProgressBar = ({ progress }: { progress: number }) => (
  <View style={styles.webProgressBar}>
    <View style={[styles.webProgressFill, { width: `${progress}%` }]} />
  </View>
);

// ==========================================================
export default function App() {
  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [currentTransfer, setCurrentTransfer] = useState<FileTransfer | null>(null);
  const [loading, setLoading] = useState(false);
  const [isLogin, setIsLogin] = useState(true);

  const deviceId = useRef(Platform.OS + '-' + Date.now()).current;
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const fileBuffer = useRef<ArrayBuffer[]>([]);
  const receivedSize = useRef(0);
  const expectedFileSize = useRef(0);
  const expectedFileName = useRef('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        registerDevice(currentUser.email!);
        listenForDevices(currentUser.email!);
        listenForSignaling();
      }
    });
    return unsubscribe;
  }, []);

  // ---------------- device discovery ----------------
  const registerDevice = (email: string) => {
    const deviceRef = ref(database, `devices/${email.replace(/\./g, '_')}/${deviceId}`);
    const deviceName = isWeb ? 'Web Browser' : Platform.OS;
    set(deviceRef, { email, deviceName, lastSeen: Date.now() });

    const disconnectRef = onDisconnect(deviceRef);
    disconnectRef.remove();

    const interval = setInterval(() => {
      set(deviceRef, { email, deviceName, lastSeen: Date.now() });
    }, 30000);

    return () => clearInterval(interval);
  };

  const listenForDevices = (email: string) => {
    const devicesRef = ref(database, `devices/${email.replace(/\./g, '_')}`);
    onValue(devicesRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const deviceList: Device[] = Object.entries(data)
          .filter(([id]) => id !== deviceId)
          .map(([id, device]: [string, any]) => ({
            id,
            email: device.email,
            deviceName: device.deviceName,
            lastSeen: device.lastSeen,
          }))
          .filter((d) => Date.now() - d.lastSeen < 60000);
        setDevices(deviceList);
      } else setDevices([]);
    });
  };

  // ---------------- signaling ----------------
  const listenForSignaling = () => {
    const signalingRef = ref(database, `signaling/${deviceId}`);
    onValue(signalingRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      if (data.offer) {
        await handleOffer(data.offer, data.fromDevice);
        remove(signalingRef);
      } else if (data.answer) {
        await handleAnswer(data.answer);
        remove(signalingRef);
      } else if (data.candidate) {
        await handleIceCandidate(data.candidate);
      }
    });
  };

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(rtcConfig);
    pc.onicecandidate = (event) => {
      if (event.candidate && selectedDevice) {
        const candidateRef = ref(database, `signaling/${selectedDevice}`);
        set(candidateRef, {
          candidate: event.candidate.toJSON(),
          fromDevice: deviceId,
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        showAlert('Error', 'Connection failed. Please try again.');
        setCurrentTransfer(null);
        closePeerConnection();
      }
    };
    return pc;
  };

  const handleOffer = async (offer: any, fromDevice: string) => {
    const pc = (peerConnection.current = createPeerConnection());
    pc.ondatachannel = (event) => setupDataChannel(event.channel);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const answerRef = ref(database, `signaling/${fromDevice}`);
    await set(answerRef, {
      answer: pc.localDescription?.toJSON(),
      fromDevice: deviceId,
    });
  };

  const handleAnswer = async (answer: any) => {
    if (peerConnection.current) {
      await peerConnection.current.setRemoteDescription(new RTCSessionDescription(answer));
    }
  };

  const handleIceCandidate = async (candidate: any) => {
    if (peerConnection.current) {
      try {
        await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    }
  };

  // ---------------- data channel ----------------
  const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannel.current = channel;
    channel.onopen = () => console.log('Data channel opened');
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const metadata = JSON.parse(event.data);
        expectedFileSize.current = metadata.fileSize;
        expectedFileName.current = metadata.fileName;
        fileBuffer.current = [];
        receivedSize.current = 0;
        setCurrentTransfer({ fileName: metadata.fileName, fileSize: metadata.fileSize, progress: 0, status: 'transferring' });
      } else {
        fileBuffer.current.push(event.data);
        receivedSize.current += event.data.byteLength;
        const progress = (receivedSize.current / expectedFileSize.current) * 100;
        setCurrentTransfer((p) => (p ? { ...p, progress } : null));
        if (receivedSize.current === expectedFileSize.current) saveReceivedFile();
      }
    };
    channel.onerror = (e) => {
      console.error('Data channel error:', e);
      showAlert('Error', 'File transfer failed');
      setCurrentTransfer(null);
    };
    channel.onclose = () => closePeerConnection();
  };

  // ---------------- SAVING FILE (FIXED) ----------------
  const saveReceivedFile = async () => {
    try {
      const blob = new Blob(fileBuffer.current);
      if (isWeb) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = expectedFileName.current;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setCurrentTransfer(p => p ? { ...p, status: 'completed', progress: 100 } : null);
        showAlert('Success', 'File downloaded successfully!');
      } else {
        const FileSystem = await import('expo-file-system');
        const { writeAsStringAsync, documentDirectory, EncodingType } = FileSystem;
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1];
          const fileUri = documentDirectory + expectedFileName.current;
          await writeAsStringAsync(fileUri, base64, { encoding: EncodingType.Base64 });
          setCurrentTransfer(p => p ? { ...p, status: 'completed', progress: 100 } : null);
          showAlert('Success', `File saved to: ${fileUri}`);
        };
        reader.readAsDataURL(blob);
      }
      setTimeout(() => setCurrentTransfer(null), 2000);
    } catch (err: any) {
      console.error('Save file error:', err);
      showAlert('Error', err.message || 'Failed to save file');
      setCurrentTransfer(p => p ? { ...p, status: 'failed' } : null);
    }
  };

  // ---------------- PICK & SEND FILE (FIXED) ----------------
  const pickAndSendFile = async () => {
    if (!selectedDevice) {
      showAlert('Error', 'Please select a device first');
      return;
    }
    try {
      if (isWeb) {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async (e: any) => {
          const file = e.target.files[0];
          if (!file) return;
          const arrayBuffer = await file.arrayBuffer();
          await sendFileData(file.name, file.size, arrayBuffer);
        };
        input.click();
        return;
      }

      const DocumentPicker = await import('expo-document-picker');
      const FileSystem = await import('expo-file-system');
      const { readAsStringAsync, EncodingType } = FileSystem;

      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (!result.canceled && result.assets && result.assets[0]) {
        const file = result.assets[0];
        const fileContent = await readAsStringAsync(file.uri, { encoding: EncodingType.Base64 });
        const binary = atob(fileContent);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await sendFileData(file.name, file.size || bytes.length, bytes.buffer);
      } else {
        console.log('File selection cancelled');
      }

    } catch (error: any) {
      console.error('File pick error:', error);
      showAlert('Error', error.message || 'Failed to pick file');
      setLoading(false);
      closePeerConnection();
    }
  };

  const sendFileData = async (fileName: string, fileSize: number, fileData: ArrayBuffer) => {
    setLoading(true);
    const pc = (peerConnection.current = createPeerConnection());
    const channel = pc.createDataChannel('fileTransfer');
    dataChannel.current = channel;

    channel.onopen = async () => {
      setLoading(false);
      channel.send(JSON.stringify({ fileName, fileSize }));
      setCurrentTransfer({ fileName, fileSize, progress: 0, status: 'transferring' });
      const bytes = new Uint8Array(fileData);
      const chunkSize = 16384;
      let offset = 0;

      const sendChunk = () => {
        if (offset < bytes.length && channel.readyState === 'open') {
          const chunk = bytes.slice(offset, offset + chunkSize);
          channel.send(chunk);
          offset += chunkSize;
          const progress = Math.min((offset / bytes.length) * 100, 100);
          setCurrentTransfer(p => p ? { ...p, progress } : null);
          setTimeout(sendChunk, 10);
        } else if (offset >= bytes.length) {
          setCurrentTransfer(p => p ? { ...p, status: 'completed', progress: 100 } : null);
          setTimeout(() => {
            setCurrentTransfer(null);
            closePeerConnection();
          }, 2000);
        }
      };
      sendChunk();
    };

    channel.onerror = (e) => {
      console.error('Data channel error:', e);
      showAlert('Error', 'File transfer failed');
      setLoading(false);
      setCurrentTransfer(null);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offerRef = ref(database, `signaling/${selectedDevice}`);
    await set(offerRef, {
      offer: pc.localDescription?.toJSON(),
      fromDevice: deviceId,
    });
  };

  const closePeerConnection = () => {
    dataChannel.current?.close();
    peerConnection.current?.close();
    dataChannel.current = null;
    peerConnection.current = null;
  };

  // ------------- AUTH + UI -------------
  const handleSignOut = async () => {
    const deviceRef = ref(database, `devices/${user.email.replace(/\./g, '_')}/${deviceId}`);
    await remove(deviceRef);
    closePeerConnection();
    await signOut(auth);
  };

  const handleAuth = async () => {
    setLoading(true);
    try {
      if (isLogin) await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      showAlert('Error', err.message);
    }
    setLoading(false);
  };

  const showAlert = (title: string, message: string) => {
    if (isWeb) alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  const getDeviceIcon = (name: string) => {
    if (name.includes('Web')) return '💻';
    if (name === 'ios') return '📱';
    if (name === 'android') return '🤖';
    return '📱';
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>P2P File Transfer</Text>
        <Text style={styles.subtitle}>Direct WiFi Transfer • Mobile & Web • No Server Storage</Text>
        <TextInput style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" />
        <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
        <TouchableOpacity style={styles.button} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{isLogin ? 'Sign In' : 'Sign Up'}</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setIsLogin(!isLogin)}>
          <Text style={styles.linkText}>
            {isLogin ? 'Need an account? Sign Up' : 'Have an account? Sign In'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerText}>{user.email}</Text>
          <Text style={styles.subHeaderText}>🔒 Direct P2P Transfer • {isWeb ? '💻 Web' : '📱 Mobile'}</Text>
        </View>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      {currentTransfer && (
        <View style={styles.transferCard}>
          <Text style={styles.transferTitle}>
            {currentTransfer.status === 'transferring' ? '📤 Transferring...' : '✅ Complete!'}
          </Text>
          <Text style={styles.transferFileName}>{currentTransfer.fileName}</Text>
          <Text style={styles.transferSize}>{(currentTransfer.fileSize / 1024 / 1024).toFixed(2)} MB</Text>
          <WebProgressBar progress={currentTransfer.progress} />
          <Text style={styles.progressText}>{currentTransfer.progress.toFixed(0)}%</Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📱 Available Devices ({devices.length})</Text>
        <FlatList
          data={devices}
          scrollEnabled={false}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.deviceItem, selectedDevice === item.id && styles.selectedDevice]}
              onPress={() => setSelectedDevice(item.id)}
            >
              <Text style={styles.deviceName}>{getDeviceIcon(item.deviceName)} {item.deviceName}</Text>
              <Text style={styles.deviceEmail}>{item.email}</Text>
              <View style={styles.onlineBadge}><Text style={styles.onlineText}>● Online</Text></View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No devices online{'\n'}Sign in on another device with the same email</Text>}
        />
      </View>

      <TouchableOpacity
        style={[styles.sendButton, (!selectedDevice || loading || currentTransfer) && styles.disabledButton]}
        onPress={pickAndSendFile}
        disabled={!selectedDevice || loading || !!currentTransfer}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>📎 Select & Send File</Text>}
      </TouchableOpacity>

      <View style={styles.infoBox}>
        <Text style={styles.infoText}>
          ℹ️ Files transfer directly between devices over Wi‑Fi/Internet{'\n'}
          Works between mobile apps and web browsers{'\n'}
          No files are stored on any server
        </Text>
      </View>
    </ScrollView>
  );
}

// ---------------- Styles ----------------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5', padding: 20, paddingTop: 50 },
  title: { fontSize: 32, fontWeight: 'bold', textAlign: 'center', marginBottom: 10, color: '#333' },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 40, color: '#666', lineHeight: 20 },
  input: { backgroundColor: '#fff', padding: 15, borderRadius: 10, marginBottom: 15, fontSize: 16, borderWidth: 1, borderColor: '#ddd' },
  button: { backgroundColor: '#007AFF', padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 15 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  linkText: { color: '#007AFF', textAlign: 'center', fontSize: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  headerText: { fontSize: 14, color: '#333', fontWeight: '600' },
  subHeaderText: { fontSize: 12, color: '#34C759', marginTop: 2 },
  signOutText: { color: '#FF3B30', fontSize: 14, fontWeight: '600' },
  transferCard: { backgroundColor: '#E3F2FF', borderRadius: 12, padding: 15, marginBottom: 20, borderWidth: 2, borderColor: '#007AFF' },
  transferTitle: { fontSize: 16, fontWeight: '700', color: '#007AFF', marginBottom: 8 },
  transferFileName: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 4 },
  transferSize: { fontSize: 12, color: '#666', marginBottom: 10 },
  webProgressBar: { height: 8, backgroundColor: '#E0E0E0', borderRadius: 4, overflow: 'hidden', marginBottom: 8 },
  webProgressFill: { height: '100%', backgroundColor: '#007AFF', borderRadius: 4 },
  progressText: { fontSize: 12, color: '#007AFF', textAlign: 'center', fontWeight: '600' },
  section: { marginBottom: 20, backgroundColor: '#fff', borderRadius: 10, padding: 15 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 10, color: '#333' },
  deviceItem: { padding: 12, borderRadius: 8, backgroundColor: '#f9f9f9', marginBottom: 8, borderWidth: 2, borderColor: 'transparent' },
  selectedDevice: { borderColor: '#007AFF', backgroundColor: '#E3F2FF' },
  deviceName: { fontSize: 16, fontWeight: '600', color: '#333' },
  deviceEmail: { fontSize: 12, color: '#666', marginTop: 2 },
  onlineBadge: { marginTop: 4 },
  onlineText: { fontSize: 11, color: '#34C759', fontWeight: '600' },
  sendButton: { backgroundColor: '#34C759', padding: 18, borderRadius: 10, alignItems: 'center', marginBottom: 15 },
  disabledButton: { backgroundColor: '#ccc' },
  emptyText: { textAlign: 'center', color: '#999', fontSize: 14, paddingVertical: 20, lineHeight: 20 },
  infoBox: { backgroundColor: '#FFF3CD', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#FFC107', marginBottom: 20 },
  infoText: { fontSize: 12, color: '#856404', textAlign: 'center', lineHeight: 18 },
})