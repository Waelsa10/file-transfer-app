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
  initializeAuth,
  getReactNativePersistence,
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
  update,
} from 'firebase/database';

// Conditional imports
const isWeb = Platform.OS === 'web';
let DocumentPicker: any;
let FileSystem: any;
let Sharing: any;
let Network: any;
let AsyncStorage: any;

if (!isWeb) {
  DocumentPicker = require('expo-document-picker');
  FileSystem = require('expo-file-system/legacy');
  Sharing = require('expo-sharing');
  Network = require('expo-network');
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
}

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCK7AV4BHrj0o_sPhstug4ph59adWv1eb0",
  authDomain: "file-transfer-app-9f7bd.firebaseapp.com",
  databaseURL: "https://file-transfer-app-9f7bd-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "file-transfer-app-9f7bd",
  storageBucket: "file-transfer-app-9f7bd.firebasestorage.app",
  messagingSenderId: "31409683737",
  appId: "1:31409683737:web:4b48323ff521d3d4619988",
  measurementId: "G-SDRWCQRRTW"
};

const app = initializeApp(firebaseConfig);

// Initialize Auth with AsyncStorage for mobile
let auth: any;
if (isWeb) {
  const { getAuth } = require('firebase/auth');
  auth = getAuth(app);
} else {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage)
  });
}

const database = getDatabase(app);

interface Device {
  id: string;
  email: string;
  deviceName: string;
  lastSeen: number;
  localIP?: string;
}

interface FileTransfer {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'uploading' | 'downloading' | 'completed' | 'failed';
}

interface ReceivedFile {
  id: string;
  fileName: string;
  fileSize: number;
  fileUri?: string;
  receivedAt: number;
  fromDevice: string;
}

const WebProgressBar = ({ progress }: { progress: number }) => (
  <View style={styles.webProgressBar}>
    <View style={[styles.webProgressFill, { width: `${progress}%` }]} />
  </View>
);

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [currentTransfers, setCurrentTransfers] = useState<FileTransfer[]>([]);
  const [loading, setLoading] = useState(false);
  const [isLogin, setIsLogin] = useState(true);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [localIP, setLocalIP] = useState<string>('');

  const deviceId = useRef(Platform.OS + '-' + Date.now()).current;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        getLocalIP();
        registerDevice(currentUser.email!);
        listenForDevices(currentUser.email!);
        listenForFileTransfers();
        loadReceivedFiles(currentUser.email!);
      }
    });
    return unsubscribe;
  }, []);

  const getLocalIP = async () => {
    try {
      if (!isWeb) {
        const ip = await Network.getIpAddressAsync();
        setLocalIP(ip);
      }
    } catch (error) {
      console.log('Could not get local IP:', error);
    }
  };

  const registerDevice = (email: string) => {
    const deviceRef = ref(database, `devices/${email.replace(/\./g, '_')}/${deviceId}`);
    
    const deviceName = isWeb ? 'Web Browser' : Platform.OS;
    
    set(deviceRef, {
      email,
      deviceName,
      lastSeen: Date.now(),
      localIP: localIP || 'unknown',
    });

    const disconnectRef = onDisconnect(deviceRef);
    disconnectRef.remove();

    const interval = setInterval(() => {
      set(deviceRef, {
        email,
        deviceName,
        lastSeen: Date.now(),
        localIP: localIP || 'unknown',
      });
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
            localIP: device.localIP,
          }))
          .filter((device) => Date.now() - device.lastSeen < 60000);
        setDevices(deviceList);
      } else {
        setDevices([]);
      }
    });
  };

  const loadReceivedFiles = (email: string) => {
    const filesRef = ref(database, `receivedFiles/${email.replace(/\./g, '_')}/${deviceId}`);
    
    onValue(filesRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const filesList: ReceivedFile[] = Object.entries(data).map(([id, file]: [string, any]) => ({
          id,
          ...file,
        })).sort((a, b) => b.receivedAt - a.receivedAt);
        setReceivedFiles(filesList);
      } else {
        setReceivedFiles([]);
      }
    });
  };

  const saveReceivedFileMetadata = async (fileName: string, fileSize: number, fileUri: string, fromDevice: string) => {
    if (!user) return;

    const filesRef = ref(database, `receivedFiles/${user.email.replace(/\./g, '_')}/${deviceId}/${Date.now()}`);
    
    await set(filesRef, {
      fileName,
      fileSize,
      fileUri: isWeb ? '' : fileUri,
      receivedAt: Date.now(),
      fromDevice,
    });
  };

  // Listen for incoming file transfers
  const listenForFileTransfers = () => {
    const transfersRef = ref(database, `transfers/${deviceId}`);
    
    onValue(transfersRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      for (const [transferId, transfer] of Object.entries(data as any)) {
        if (transfer.status === 'pending') {
          await receiveFile(transferId, transfer);
        }
      }
    });
  };

  const receiveFile = async (transferId: string, transfer: any) => {
    try {
      const { fileName, fileSize, chunks, totalChunks, fromDevice } = transfer;
      
      console.log('Receiving file:', fileName, 'Size:', fileSize);

      const downloadId = `download-${Date.now()}`;
      setCurrentTransfers(prev => [...prev, {
        id: downloadId,
        fileName,
        fileSize,
        progress: 0,
        status: 'downloading',
      }]);

      // Update status to downloading
      await update(ref(database, `transfers/${deviceId}/${transferId}`), {
        status: 'downloading',
      });

      // Collect all chunks
      const chunkArray: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (chunks[i]) {
          chunkArray.push(chunks[i]);
          const progress = ((i + 1) / totalChunks) * 100;
          setCurrentTransfers(prev => prev.map(t => 
            t.id === downloadId ? { ...t, progress } : t
          ));
        }
      }

      // Combine chunks
      const base64Data = chunkArray.join('');
      
      console.log('File received, saving...');

      let savedUri = '';

      if (isWeb) {
        // Web: Download file
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray]);

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        savedUri = 'web-download';
      } else {
        // Mobile: Save to file system
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });
        savedUri = fileUri;
      }

      // Save metadata
      await saveReceivedFileMetadata(fileName, fileSize, savedUri, fromDevice);

      // Update transfer status
      setCurrentTransfers(prev => prev.map(t => 
        t.id === downloadId ? { ...t, status: 'completed', progress: 100 } : t
      ));

      // Delete transfer data
      await remove(ref(database, `transfers/${deviceId}/${transferId}`));

      showAlert('Success', 'File received successfully!');

      setTimeout(() => {
        setCurrentTransfers(prev => prev.filter(t => t.id !== downloadId));
      }, 2000);
    } catch (error: any) {
      console.error('Receive error:', error);
      showAlert('Error', error.message || 'Failed to receive file');
    }
  };

  const uploadAndSendFile = async (fileName: string, fileSize: number, base64Data: string) => {
    try {
      if (!user || !selectedDevice) return;

      console.log('Sending file:', fileName, 'Size:', fileSize);

      // File size limit: 10MB for database transfer
      if (fileSize > 10 * 1024 * 1024) {
        showAlert('Error', 'File too large. Maximum size is 10MB for database transfers.');
        return;
      }

      const transferId = `upload-${Date.now()}`;
      setCurrentTransfers(prev => [...prev, {
        id: transferId,
        fileName,
        fileSize,
        progress: 0,
        status: 'uploading',
      }]);

      // Split into chunks (50KB per chunk to avoid database limits)
      const chunkSize = 50000;
      const totalChunks = Math.ceil(base64Data.length / chunkSize);
      const chunks: { [key: number]: string } = {};

      console.log('Splitting into', totalChunks, 'chunks...');

      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64Data.slice(i * chunkSize, (i + 1) * chunkSize);
        chunks[i] = chunk;
        
        const progress = ((i + 1) / totalChunks) * 100;
        setCurrentTransfers(prev => prev.map(t => 
          t.id === transferId ? { ...t, progress } : t
        ));
      }

      console.log('Uploading to database for device:', selectedDevice);

      // Send to target device
      const transferRef = ref(database, `transfers/${selectedDevice}/${transferId}`);
      
      await set(transferRef, {
        fileName,
        fileSize,
        chunks,
        totalChunks,
        status: 'pending',
        fromDevice: deviceId,
        timestamp: Date.now(),
      });

      console.log('File sent successfully!');

      setCurrentTransfers(prev => prev.map(t => 
        t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
      ));

      showAlert('Success', 'File sent successfully!');

      setTimeout(() => {
        setCurrentTransfers(prev => prev.filter(t => t.id !== transferId));
      }, 2000);
    } catch (error: any) {
      console.error('Upload error:', error);
      
      let errorMessage = 'Failed to send file';
      if (error.code === 'PERMISSION_DENIED') {
        errorMessage = 'Permission denied. Please check Firebase Database rules.';
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      showAlert('Error', errorMessage);
      setCurrentTransfers(prev => prev.filter(t => t.fileName === fileName));
    }
  };

  const pickAndSendFiles = async (multiple: boolean = false) => {
    if (!selectedDevice) {
      showAlert('Error', 'Please select a device first');
      return;
    }

    setLoading(true);

    try {
      if (isWeb) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        
        input.onchange = async (e: any) => {
          const files = Array.from(e.target.files) as File[];
          if (files.length === 0) {
            setLoading(false);
            return;
          }

          for (const file of files) {
            const reader = new FileReader();
            reader.onload = async () => {
              const base64 = (reader.result as string).split(',')[1];
              await uploadAndSendFile(file.name, file.size, base64);
            };
            reader.readAsDataURL(file);
          }
          
          setLoading(false);
        };

        input.click();
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: multiple,
        });

        if (result.canceled === false && result.assets && result.assets.length > 0) {
          for (const file of result.assets) {
            const fileContent = await FileSystem.readAsStringAsync(file.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });

            await uploadAndSendFile(file.name, file.size || 0, fileContent);
          }
        }
        
        setLoading(false);
      }
    } catch (error: any) {
      console.error('File pick error:', error);
      showAlert('Error', error.message || 'Failed to pick file');
      setLoading(false);
    }
  };

  const openReceivedFile = async (file: ReceivedFile) => {
    try {
      if (isWeb) {
        showAlert('Info', 'File was already downloaded. Check your downloads folder.');
      } else {
        if (file.fileUri) {
          const fileInfo = await FileSystem.getInfoAsync(file.fileUri);
          if (fileInfo.exists) {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(file.fileUri);
            } else {
              showAlert('Success', `File: ${file.fileUri}`);
            }
          } else {
            showAlert('Error', 'File not found on device');
          }
        }
      }
    } catch (error: any) {
      console.error('Open file error:', error);
      showAlert('Error', error.message || 'Failed to open file');
    }
  };

  const deleteReceivedFile = async (file: ReceivedFile) => {
    try {
      if (user) {
        await remove(ref(database, `receivedFiles/${user.email.replace(/\./g, '_')}/${deviceId}/${file.id}`));
      }

      if (!isWeb && file.fileUri) {
        const fileInfo = await FileSystem.getInfoAsync(file.fileUri);
        if (fileInfo.exists) {
          await FileSystem.deleteAsync(file.fileUri);
        }
      }

      showAlert('Success', 'File deleted successfully');
    } catch (error: any) {
      console.error('Delete file error:', error);
      showAlert('Error', error.message || 'Failed to delete file');
    }
  };

  const handleSignOut = async () => {
    if (user) {
      const deviceRef = ref(database, `devices/${user.email.replace(/\./g, '_')}/${deviceId}`);
      await remove(deviceRef);
    }
    await signOut(auth);
  };

  const handleAuth = async () => {
    setLoading(true);
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (error: any) {
      showAlert('Error', error.message);
    }
    setLoading(false);
  };

  const showAlert = (title: string, message: string) => {
    if (isWeb) {
      alert(`${title}: ${message}`);
    } else {
      Alert.alert(title, message);
    }
  };

  const getDeviceIcon = (deviceName: string) => {
    if (deviceName.includes('Web')) return '💻';
    if (deviceName === 'ios') return '📱';
    if (deviceName === 'android') return '🤖';
    return '📱';
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext || '')) return '🖼️';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) return '🎥';
    if (['mp3', 'wav', 'aac', 'm4a', 'flac'].includes(ext || '')) return '🎵';
    if (['pdf'].includes(ext || '')) return '📄';
    if (['doc', 'docx', 'txt'].includes(ext || '')) return '📝';
    if (['zip', 'rar', '7z'].includes(ext || '')) return '📦';
    return '📎';
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
    
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>File Transfer</Text>
        
        <TextInput
          style={styles.input}
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        <TouchableOpacity
          style={styles.button}
          onPress={handleAuth}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {isLogin ? 'Sign In' : 'Sign Up'}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setIsLogin(!isLogin)}>
          <Text style={styles.linkText}>
            {isLogin ? 'Need an account? Sign Up' : 'Have an account? Sign In'}
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
          <Text style={styles.subHeaderText}>
            📡 {isWeb ? '💻 Web' : '📱 Mobile'} {localIP && `• ${localIP}`}
          </Text>
        </View>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      {currentTransfers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 Active Transfers</Text>
          {currentTransfers.map((transfer) => (
            <View key={transfer.id} style={styles.transferCard}>
              <Text style={styles.transferTitle}>
                {transfer.status === 'uploading' ? '📤 Uploading...' : 
                 transfer.status === 'downloading' ? '📥 Downloading...' : '✅ Complete!'}
              </Text>
              <Text style={styles.transferFileName}>{transfer.fileName}</Text>
              <Text style={styles.transferSize}>{formatFileSize(transfer.fileSize)}</Text>
              <WebProgressBar progress={transfer.progress} />
              <Text style={styles.progressText}>{transfer.progress.toFixed(0)}%</Text>
            </View>
          ))}
        </View>
      )}

      {receivedFiles.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📥 Received Files ({receivedFiles.length})</Text>
          <FlatList
            data={receivedFiles}
            scrollEnabled={false}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.fileItem}>
                <View style={styles.fileInfo}>
                  <Text style={styles.fileIcon}>{getFileIcon(item.fileName)}</Text>
                  <View style={styles.fileDetails}>
                    <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
                    <Text style={styles.fileMetadata}>
                      {formatFileSize(item.fileSize)} • {formatDate(item.receivedAt)}
                    </Text>
                  </View>
                </View>
                <View style={styles.fileActions}>
                  <TouchableOpacity
                    style={styles.openButton}
                    onPress={() => openReceivedFile(item)}
                  >
                    <Text style={styles.openButtonText}>Open</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => {
                      if (isWeb) {
                        if (confirm('Delete this file?')) {
                          deleteReceivedFile(item);
                        }
                      } else {
                        Alert.alert(
                          'Delete File',
                          'Are you sure?',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Delete', style: 'destructive', onPress: () => deleteReceivedFile(item) },
                          ]
                        );
                      }
                    }}
                  >
                    <Text style={styles.deleteButtonText}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📱 Available Devices ({devices.length})</Text>
        <FlatList
          data={devices}
          scrollEnabled={false}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.deviceItem,
                selectedDevice === item.id && styles.selectedDevice,
              ]}
              onPress={() => setSelectedDevice(item.id)}
            >
              <Text style={styles.deviceName}>
                {getDeviceIcon(item.deviceName)} {item.deviceName}
              </Text>
              <Text style={styles.deviceEmail}>{item.email}</Text>
              {item.localIP && item.localIP !== 'unknown' && (
                <Text style={styles.deviceIP}>📍 {item.localIP}</Text>
              )}
              <View style={styles.onlineBadge}>
                <Text style={styles.onlineText}>● Online</Text>
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No devices online{'\n'}Sign in on another device with the same email
            </Text>
          }
        />
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.halfButton, styles.primaryButton, (!selectedDevice || loading) && styles.disabledButton]}
          onPress={() => pickAndSendFiles(false)}
          disabled={!selectedDevice || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.buttonIcon}>📎</Text>
              <Text style={styles.buttonText}>Send File</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.halfButton, styles.secondaryButton, (!selectedDevice || loading) && styles.disabledButton]}
          onPress={() => pickAndSendFiles(true)}
          disabled={!selectedDevice || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.buttonIcon}>📁</Text>
              <Text style={styles.buttonText}>Multiple Files</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.infoBox}>
        <Text style={styles.infoText}>
          ✨ Works on iOS, Android, and Web{'\n'}
          🚀 Database-only transfer (max 10MB){'\n'}
        </Text>
      </View>
    </ScrollView>
  );
}

// ---------------- Styles ----------------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5', padding: 20, paddingTop: 50 },
  title: { fontSize: 32, fontWeight: 'bold', textAlign: 'center', marginBottom: 10, color: '#333' },
  subtitle: { fontSize: 13, textAlign: 'center', marginBottom: 40, color: '#666', lineHeight: 20 },
  input: { backgroundColor: '#fff', padding: 15, borderRadius: 10, marginBottom: 15, fontSize: 16, borderWidth: 1, borderColor: '#ddd' },
  button: { backgroundColor: '#007AFF', padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 15 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  buttonIcon: { fontSize: 20, marginBottom: 4 },
  linkText: { color: '#007AFF', textAlign: 'center', fontSize: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  headerText: { fontSize: 14, color: '#333', fontWeight: '600' },
  subHeaderText: { fontSize: 12, color: '#34C759', marginTop: 2 },
  signOutText: { color: '#FF3B30', fontSize: 14, fontWeight: '600' },
  transferCard: { backgroundColor: '#E3F2FF', borderRadius: 12, padding: 15, marginBottom: 10, borderWidth: 2, borderColor: '#007AFF' },
  transferTitle: { fontSize: 15, fontWeight: '700', color: '#007AFF', marginBottom: 8 },
  transferFileName: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 4 },
  transferSize: { fontSize: 12, color: '#666', marginBottom: 10 },
  webProgressBar: { height: 8, backgroundColor: '#E0E0E0', borderRadius: 4, overflow: 'hidden', marginBottom: 8 },
  webProgressFill: { height: '100%', backgroundColor: '#007AFF', borderRadius: 4 },
  progressText: { fontSize: 12, color: '#007AFF', textAlign: 'center', fontWeight: '600' },
  section: { marginBottom: 20, backgroundColor: '#fff', borderRadius: 10, padding: 15 },
  sectionTitle: { fontSize: 18, fontWeight: '600', marginBottom: 10, color: '#333' },
  fileItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 8, backgroundColor: '#f9f9f9', marginBottom: 8, borderWidth: 1, borderColor: '#e0e0e0' },
  fileInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  fileIcon: { fontSize: 32, marginRight: 12 },
  fileDetails: { flex: 1 },
  fileName: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 2 },
  fileMetadata: { fontSize: 11, color: '#666' },
  fileActions: { flexDirection: 'row', alignItems: 'center' },
  openButton: { backgroundColor: '#007AFF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, marginRight: 8 },
  openButtonText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  deleteButton: { padding: 6 },
  deleteButtonText: { fontSize: 18 },
  deviceItem: { padding: 12, borderRadius: 8, backgroundColor: '#f9f9f9', marginBottom: 8, borderWidth: 2, borderColor: 'transparent' },
  selectedDevice: { borderColor: '#007AFF', backgroundColor: '#E3F2FF' },
  deviceName: { fontSize: 16, fontWeight: '600', color: '#333' },
  deviceEmail: { fontSize: 12, color: '#666', marginTop: 2 },
  deviceIP: { fontSize: 11, color: '#999', marginTop: 2 },
  onlineBadge: { marginTop: 4 },
  onlineText: { fontSize: 11, color: '#34C759', fontWeight: '600' },
  buttonRow: { flexDirection: 'row', gap: 10, marginBottom: 15 },
  halfButton: { flex: 1, padding: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButton: { backgroundColor: '#34C759' },
  secondaryButton: { backgroundColor: '#007AFF' },
  disabledButton: { backgroundColor: '#ccc' },
  emptyText: { textAlign: 'center', color: '#999', fontSize: 14, paddingVertical: 20, lineHeight: 20 },
  infoBox: { backgroundColor: '#E8F5E9', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#4CAF50', marginBottom: 20 },
  infoText: { fontSize: 12, color: '#2E7D32', textAlign: 'center', lineHeight: 18 },
});