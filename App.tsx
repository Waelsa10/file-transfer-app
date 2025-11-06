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
  Dimensions,
} from 'react-native';
import { io, Socket } from 'socket.io-client';

// Conditional imports
const isWeb = Platform.OS === 'web';
let DocumentPicker: any;
let FileSystem: any;
let Sharing: any;
let Network: any;
let AsyncStorage: any;

if (!isWeb) {
  try {
    DocumentPicker = require('expo-document-picker');
    FileSystem = require('expo-file-system/legacy');
    Sharing = require('expo-sharing');
    Network = require('expo-network');
    AsyncStorage = require('@react-native-async-storage/async-storage').default;
  } catch (e) {
    console.log('Some packages not available on this platform');
  }
}

interface Device {
  id: string;
  email: string;
  deviceName: string;
}

interface FileTransfer {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'uploading' | 'downloading' | 'completed' | 'failed';
  direction: 'send' | 'receive';
}

interface ReceivedFile {
  id: string;
  fileName: string;
  fileSize: number;
  fileUri?: string;
  receivedAt: number;
}

const WebProgressBar = ({ progress }: { progress: number }) => (
  <View style={styles.webProgressBar}>
    <View style={[styles.webProgressFill, { width: `${progress}%` }]} />
  </View>
);

export default function App() {
  const [serverIP, setServerIP] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLogin, setIsLogin] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [currentTransfers, setCurrentTransfers] = useState<FileTransfer[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [localIP, setLocalIP] = useState<string>('');
  const [currentEmail, setCurrentEmail] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<any>(null);
  const dataChannelRef = useRef<any>(null);
  const deviceIdRef = useRef(Platform.OS + '-' + Date.now());
  const fileBufferRef = useRef<any>({});
  const fileMetadataRef = useRef<any>({});

  useEffect(() => {
    getLocalIP();
    loadSavedData();
  }, []);

  const getLocalIP = async () => {
    try {
      if (!isWeb) {
        const ip = await Network.getIpAddressAsync();
        setLocalIP(ip);
      }
    } catch (error) {
      console.log('Could not get local IP');
    }
  };

  const loadSavedData = async () => {
    try {
      let savedData = null;

      if (isWeb) {
        savedData = localStorage.getItem('fileTransferData');
      } else {
        savedData = await AsyncStorage.getItem('fileTransferData');
      }

      if (savedData) {
        const data = JSON.parse(savedData);
        setEmail(data.email);
        setServerIP(data.serverIP);
        if (data.email && data.serverIP) {
          // Auto-connect after loading
          setTimeout(() => {
            handleAutoLogin(data.email, data.serverIP);
          }, 500);
        }
      }
    } catch (error) {
      console.log('Error loading saved data:', error);
    }
  };

  const saveData = async () => {
    try {
      const data = { email, serverIP };
      if (isWeb) {
        localStorage.setItem('fileTransferData', JSON.stringify(data));
      } else {
        await AsyncStorage.setItem('fileTransferData', JSON.stringify(data));
      }
    } catch (error) {
      console.log('Error saving data:', error);
    }
  };

  const handleAutoLogin = (userEmail: string, userServerIP: string) => {
    setCurrentEmail(userEmail);
    setIsLoggedIn(true);
    connectSocket(userEmail, userServerIP);
  };

  const handleAuth = async () => {
    if (!email) {
      showAlert('Error', 'Please enter an email');
      return;
    }

    if (!serverIP) {
      showAlert('Error', 'Please enter server IP address');
      return;
    }

    if (!email.includes('@')) {
      showAlert('Error', 'Please enter a valid email');
      return;
    }

    setLoading(true);
    try {
      setCurrentEmail(email);
      await saveData();
      setIsLoggedIn(true);
      connectSocket(email, serverIP);
    } catch (error: any) {
      showAlert('Error', error.message || 'Authentication failed');
      setLoading(false);
    }
  };

  const connectSocket = (userEmail: string, userServerIP: string) => {
    try {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      setConnectionStatus('connecting');

      const socketURL = `http://${userServerIP}:3000`;
      console.log('Connecting to:', socketURL);

      const socket = io(socketURL, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 10,
        transports: ['websocket', 'polling'],
        forceNew: true,
      });

      socket.on('connect', () => {
        console.log('✅ Connected to signaling server');
        setConnectionStatus('connected');
        setLoading(false);
        socket.emit('register', userEmail);
        fetchDevices(socket, userEmail);

        // Refresh devices every 3 seconds
        const interval = setInterval(() => {
          fetchDevices(socket, userEmail);
        }, 3000);

        socket.on('disconnect', () => {
          clearInterval(interval);
        });
      });

      socket.on('transfer-request', (data) => {
        Alert.alert(
          'File Transfer Request',
          `Receive: ${data.fileName} (${formatFileSize(data.fileSize)})?`,
          [
            {
              text: 'Reject',
              onPress: () => socket.emit('reject-transfer', data.fromDeviceId),
              style: 'cancel',
            },
            {
              text: 'Accept',
              onPress: async () => {
                await initiateP2PConnection(data.fromDeviceId, true, socket);
                socket.emit('accept-transfer', data.fromDeviceId);
              },
            },
          ],
          { cancelable: false }
        );
      });

      socket.on('transfer-accepted', async (data) => {
        console.log('✅ Transfer accepted');
        await setupDataChannel();
      });

      socket.on('transfer-rejected', (data) => {
        showAlert('Transfer Rejected', 'The receiver rejected your file transfer');
      });

      socket.on('offer', async (data) => {
        await handleOffer(data.offer, data.from, socket);
      });

      socket.on('answer', async (data) => {
        await handleAnswer(data.answer);
      });

      socket.on('ice-candidate', async (data) => {
        if (peerConnectionRef.current) {
          try {
            await peerConnectionRef.current.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } catch (error) {
            console.log('Error adding ice candidate');
          }
        }
      });

      socket.on('connect_error', (error) => {
        console.error('❌ Socket connection error:', error.message);
        setConnectionStatus('disconnected');
        showAlert('Connection Error', `Cannot connect to server at ${userServerIP}:3000. Check your IP address.`);
        setLoading(false);
      });

      socket.on('disconnect', () => {
        console.log('Disconnected from server');
        setConnectionStatus('disconnected');
        setDevices([]);
      });

      socket.on('error', (error) => {
        console.error('Socket error:', error);
      });

      socketRef.current = socket;
    } catch (error: any) {
      console.error('Connection error:', error);
      setConnectionStatus('disconnected');
      showAlert('Error', error.message || 'Failed to connect');
      setLoading(false);
    }
  };

  const fetchDevices = async (socket: Socket, userEmail: string) => {
    socket.emit('get-users', userEmail, (deviceIds: string[]) => {
      const deviceList: Device[] = deviceIds.map((id) => ({
        id,
        email: userEmail,
        deviceName: extractDeviceType(id),
      }));
      setDevices(deviceList);
    });
  };

  const extractDeviceType = (id: string) => {
    if (id.includes('web')) return 'Web Browser';
    if (id.includes('android')) return 'Android Device';
    if (id.includes('ios')) return 'iOS Device';
    return 'Device';
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
            await sendFile(file);
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

        if (!result.canceled && result.assets && result.assets.length > 0) {
          for (const asset of result.assets) {
            try {
              const fileContent = await FileSystem.readAsStringAsync(asset.uri, {
                encoding: FileSystem.EncodingType.Base64,
              });

              const file = {
                name: asset.name,
                size: asset.size || 0,
                base64: fileContent,
              };

              await sendFileP2P(file);
            } catch (fileError) {
              console.error('Error reading file:', fileError);
            }
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

  const sendFile = async (file: File) => {
    const transferId = `upload-${Date.now()}`;

    setCurrentTransfers((prev) => [
      ...prev,
      {
        id: transferId,
        fileName: file.name,
        fileSize: file.size,
        progress: 0,
        status: 'uploading',
        direction: 'send',
      },
    ]);

    try {
      socketRef.current?.emit('initiate-transfer', {
        targetDeviceId: selectedDevice,
        fileName: file.name,
        fileSize: file.size,
      });

      await initiateP2PConnection(selectedDevice!, false, socketRef.current!);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
        throw new Error('Data channel not ready');
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer;
          const chunkSize = 16384;

          const metadata = {
            type: 'metadata',
            fileName: file.name,
            fileSize: file.size,
            totalChunks: Math.ceil(arrayBuffer.byteLength / chunkSize),
          };

          dataChannelRef.current.send(JSON.stringify(metadata));

          let sentBytes = 0;
          for (let i = 0; i < arrayBuffer.byteLength; i += chunkSize) {
            if (dataChannelRef.current.readyState !== 'open') {
              throw new Error('Data channel closed during transfer');
            }

            const chunk = arrayBuffer.slice(i, i + chunkSize);
            dataChannelRef.current.send(chunk);

            sentBytes += chunk.byteLength;
            const progress = (sentBytes / arrayBuffer.byteLength) * 100;

            setCurrentTransfers((prev) =>
              prev.map((t) =>
                t.id === transferId
                  ? { ...t, progress: Math.min(progress, 99) }
                  : t
              )
            );

            await new Promise((resolve) => setTimeout(resolve, 10));
          }

          dataChannelRef.current.send(JSON.stringify({ type: 'complete' }));

          setCurrentTransfers((prev) =>
            prev.map((t) =>
              t.id === transferId
                ? { ...t, status: 'completed', progress: 100 }
                : t
            )
          );

          showAlert('Success', `${file.name} sent!`);

          setTimeout(() => {
            setCurrentTransfers((prev) =>
              prev.filter((t) => t.id !== transferId)
            );
          }, 2000);
        } catch (error) {
          console.error('Error:', error);
          setCurrentTransfers((prev) =>
            prev.map((t) =>
              t.id === transferId ? { ...t, status: 'failed' } : t
            )
          );
          showAlert('Error', 'Failed to send file');
        }
      };

      reader.onerror = () => {
        showAlert('Error', 'Failed to read file');
        setCurrentTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId ? { ...t, status: 'failed' } : t
          )
        );
      };

      reader.readAsArrayBuffer(file);
    } catch (error: any) {
      console.error('Send error:', error);
      showAlert('Error', error.message || 'Failed to send file');
      setCurrentTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId ? { ...t, status: 'failed' } : t
        )
      );
    }
  };

  const sendFileP2P = async (file: any) => {
    const transferId = `upload-${Date.now()}`;

    setCurrentTransfers((prev) => [
      ...prev,
      {
        id: transferId,
        fileName: file.name,
        fileSize: file.size,
        progress: 0,
        status: 'uploading',
        direction: 'send',
      },
    ]);

    try {
      socketRef.current?.emit('initiate-transfer', {
        targetDeviceId: selectedDevice,
        fileName: file.name,
        fileSize: file.size,
      });

      await initiateP2PConnection(selectedDevice!, false, socketRef.current!);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
        throw new Error('Data channel not ready');
      }

      const metadata = {
        type: 'metadata',
        fileName: file.name,
        fileSize: file.size,
        base64: file.base64,
      };

      dataChannelRef.current.send(JSON.stringify(metadata));

      for (let i = 0; i <= 100; i += 10) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        setCurrentTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId
              ? { ...t, progress: Math.min(i, 99) }
              : t
          )
        );
      }

      dataChannelRef.current.send(JSON.stringify({ type: 'complete' }));

      setCurrentTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? { ...t, status: 'completed', progress: 100 }
            : t
        )
      );

      showAlert('Success', `${file.name} sent!`);

      setTimeout(() => {
        setCurrentTransfers((prev) =>
          prev.filter((t) => t.id !== transferId)
        );
      }, 2000);
    } catch (error: any) {
      console.error('Send error:', error);
      showAlert('Error', error.message || 'Failed to send file');
      setCurrentTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId ? { ...t, status: 'failed' } : t
        )
      );
    }
  };

  const initiateP2PConnection = async (
    targetDeviceId: string,
    isReceiver: boolean,
    socket: Socket
  ) => {
    try {
      // Get RTCPeerConnection from global or require
      let RTCPeerConnection: any;
      let RTCIceCandidate: any;
      let RTCSessionDescription: any;

      if (isWeb) {
        RTCPeerConnection = (window as any).RTCPeerConnection;
        RTCIceCandidate = (window as any).RTCIceCandidate;
        RTCSessionDescription = (window as any).RTCSessionDescription;
      } else {
        try {
          const webrtc = require('react-native-webrtc');
          RTCPeerConnection = webrtc.RTCPeerConnection;
          RTCIceCandidate = webrtc.RTCIceCandidate;
          RTCSessionDescription = webrtc.RTCSessionDescription;
        } catch (e) {
          console.error('WebRTC not available:', e);
          throw new Error('WebRTC library not available');
        }
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: ['stun:stun1.l.google.com:19302'] },
        ],
      });

      pc.onicecandidate = (event: any) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            to: targetDeviceId,
            candidate: event.candidate,
          });
        }
      };

      if (!isReceiver) {
        const dc = pc.createDataChannel('fileTransfer', {
          ordered: true,
          maxRetransmits: 3000,
        });
        setupDataChannelEventHandlers(dc);
        dataChannelRef.current = dc;
      } else {
        pc.ondatachannel = (event: any) => {
          setupDataChannelEventHandlers(event.channel);
          dataChannelRef.current = event.channel;
        };
      }

      if (!isReceiver) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', {
          to: targetDeviceId,
          offer: pc.localDescription,
        });
      }

      peerConnectionRef.current = pc;
    } catch (error) {
      console.error('P2P connection error:', error);
      throw error;
    }
  };

  const handleOffer = async (offer: any, fromDeviceId: string, socket: Socket) => {
    try {
      let RTCPeerConnection: any;
      let RTCIceCandidate: any;
      let RTCSessionDescription: any;

      if (isWeb) {
        RTCPeerConnection = (window as any).RTCPeerConnection;
        RTCIceCandidate = (window as any).RTCIceCandidate;
        RTCSessionDescription = (window as any).RTCSessionDescription;
      } else {
        const webrtc = require('react-native-webrtc');
        RTCPeerConnection = webrtc.RTCPeerConnection;
        RTCIceCandidate = webrtc.RTCIceCandidate;
        RTCSessionDescription = webrtc.RTCSessionDescription;
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302'] },
          { urls: ['stun:stun1.l.google.com:19302'] },
        ],
      });

      pc.onicecandidate = (event: any) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            to: fromDeviceId,
            candidate: event.candidate,
          });
        }
      };

      pc.ondatachannel = (event: any) => {
        setupDataChannelEventHandlers(event.channel);
        dataChannelRef.current = event.channel;
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', {
        to: fromDeviceId,
        answer: pc.localDescription,
      });

      peerConnectionRef.current = pc;
    } catch (error) {
      console.error('Offer handling error:', error);
    }
  };

  const handleAnswer = async (answer: any) => {
    if (peerConnectionRef.current) {
      try {
        let RTCSessionDescription: any;

        if (isWeb) {
          RTCSessionDescription = (window as any).RTCSessionDescription;
        } else {
          const webrtc = require('react-native-webrtc');
          RTCSessionDescription = webrtc.RTCSessionDescription;
        }

        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
        );
      } catch (error) {
        console.error('Answer handling error:', error);
      }
    }
  };

  const setupDataChannel = () => {
    if (dataChannelRef.current) {
      dataChannelRef.current.onopen = () => {
        console.log('Data channel opened');
      };

      dataChannelRef.current.onclose = () => {
        console.log('Data channel closed');
      };

      dataChannelRef.current.onerror = (error: any) => {
        console.error('Data channel error:', error);
      };
    }
  };

  const setupDataChannelEventHandlers = (dc: any) => {
    dc.onopen = () => {
      console.log('Data channel opened');
    };

    dc.onclose = () => {
      console.log('Data channel closed');
    };

    dc.onerror = (error: any) => {
      console.error('Data channel error:', error);
    };

    dc.onmessage = (event: any) => {
      handleDataChannelMessage(event.data);
    };
  };

  const handleDataChannelMessage = async (data: any) => {
    try {
      if (typeof data === 'string') {
        const message = JSON.parse(data);

        if (message.type === 'metadata') {
          fileMetadataRef.current = message;
          fileBufferRef.current[message.fileName] = [];

          const transferId = `download-${Date.now()}`;
          setCurrentTransfers((prev) => [
            ...prev,
            {
              id: transferId,
              fileName: message.fileName,
              fileSize: message.fileSize,
              progress: 0,
              status: 'downloading',
              direction: 'receive',
            },
          ]);
        } else if (message.type === 'complete') {
          const metadata = fileMetadataRef.current;

          if (isWeb) {
            if (message.base64) {
              downloadFileWeb(message.base64, metadata.fileName);
            } else {
              const base64 = (fileBufferRef.current[metadata.fileName] || []).join('');
              downloadFileWeb(base64, metadata.fileName);
            }
          } else {
            if (message.base64) {
              await saveFileToMobile(metadata.fileName, message.base64);
            } else {
              const base64 = (fileBufferRef.current[metadata.fileName] || []).join('');
              await saveFileToMobile(metadata.fileName, base64);
            }
          }

          setCurrentTransfers((prev) =>
            prev.map((t) =>
              t.fileName === metadata.fileName
                ? { ...t, status: 'completed', progress: 100 }
                : t
            )
          );

          showAlert('Success', `${metadata.fileName} received!`);

          setTimeout(() => {
            setCurrentTransfers((prev) =>
              prev.filter((t) => t.fileName !== metadata.fileName)
            );
          }, 2000);
        }
      } else {
        const buffer = new Uint8Array(data);
        const base64Chunk = btoa(String.fromCharCode(...buffer));
        const metadata = fileMetadataRef.current;

        if (metadata.fileName) {
          if (!fileBufferRef.current[metadata.fileName]) {
            fileBufferRef.current[metadata.fileName] = [];
          }
          fileBufferRef.current[metadata.fileName].push(base64Chunk);

          const totalSize = fileBufferRef.current[metadata.fileName].join('').length;
          const progress = (totalSize / (metadata.fileSize * 1.33)) * 100;

          setCurrentTransfers((prev) =>
            prev.map((t) =>
              t.fileName === metadata.fileName
                ? { ...t, progress: Math.min(progress, 99) }
                : t
            )
          );
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  };

  const downloadFileWeb = (base64: string, fileName: string) => {
    const byteCharacters = atob(base64);
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
  };

  const saveFileToMobile = async (fileName: string, base64Data: string) => {
    try {
      const fileUri = FileSystem.documentDirectory + fileName;

      await FileSystem.writeAsStringAsync(fileUri, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const transferId = Date.now().toString();
      setReceivedFiles((prev) => [
        ...prev,
        {
          id: transferId,
          fileName,
          fileSize: base64Data.length,
          fileUri,
          receivedAt: Date.now(),
        },
      ]);
    } catch (error) {
      console.error('Error saving file:', error);
      showAlert('Error', 'Failed to save file');
    }
  };

  const openReceivedFile = async (file: ReceivedFile) => {
    try {
      if (isWeb) {
        showAlert('Info', 'File already downloaded');
      } else if (file.fileUri) {
        try {
          const fileInfo = await FileSystem.getInfoAsync(file.fileUri);
          if (fileInfo.exists) {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(file.fileUri);
            } else {
              showAlert('Info', `File: ${file.fileName}`);
            }
          }
        } catch (error) {
          showAlert('Error', 'File not found');
        }
      }
    } catch (error: any) {
      showAlert('Error', error.message);
    }
  };

  const deleteReceivedFile = async (file: ReceivedFile) => {
    try {
      if (!isWeb && file.fileUri) {
        try {
          await FileSystem.deleteAsync(file.fileUri);
        } catch (e) {
          console.log('File already deleted');
        }
      }

      setReceivedFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (error: any) {
      showAlert('Error', error.message);
    }
  };

  const handleSignOut = async () => {
    setIsLoggedIn(false);
    setCurrentEmail('');
    setEmail('');
    setServerIP('');
    setDevices([]);
    setSelectedDevice(null);
    setCurrentTransfers([]);
    setReceivedFiles([]);
    setConnectionStatus('disconnected');

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    try {
      if (isWeb) {
        localStorage.removeItem('fileTransferData');
      } else {
        await AsyncStorage.removeItem('fileTransferData');
      }
    } catch (error) {
      console.log('Error clearing data');
    }
  };

  const showAlert = (title: string, message: string) => {
    if (isWeb) {
      alert(`${title}: ${message}`);
    } else {
      Alert.alert(title, message);
    }
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

    return date.toLocaleDateString();
  };

  const getDeviceIcon = (deviceName: string) => {
    if (deviceName.includes('Web')) return '💻';
    if (deviceName.includes('Android')) return '🤖';
    if (deviceName.includes('iOS')) return '📱';
    return '📱';
  };

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif'].includes(ext || '')) return '🖼️';
    if (['mp4', 'mov', 'avi'].includes(ext || '')) return '🎥';
    if (['mp3', 'wav'].includes(ext || '')) return '🎵';
    if (['pdf'].includes(ext || '')) return '📄';
    if (['zip', 'rar'].includes(ext || '')) return '📦';
    return '📎';
  };

  if (!isLoggedIn) {
    return (
      <ScrollView style={styles.container}>
        <View style={{ paddingVertical: 40 }}>
          <Text style={styles.title}>📁 File Transfer</Text>
          <Text style={styles.subtitle}>
            Direct P2P File Sharing
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Server IP Address</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g., 192.168.1.100"
            value={serverIP}
            onChangeText={setServerIP}
            autoCapitalize="none"
            editable={!loading}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="your.email@example.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            editable={!loading}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            editable={!loading}
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.disabledButton]}
            onPress={handleAuth}
            disabled={loading}
          >
            {loading ? (
              <>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.buttonText}>Connecting...</Text>
              </>
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.infoHeading}>ℹ️ Getting Started:</Text>
          <Text style={styles.infoText}>
            1. Run the signaling server on your computer{'\n'}
            2. Find your computer's IP address{'\n'}
            3. Enter it above and connect{'\n'}
            4. Use the same email on other devices
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerText}>{currentEmail}</Text>
          <Text style={[
            styles.statusText,
            connectionStatus === 'connected' ? styles.statusConnected :
            connectionStatus === 'connecting' ? styles.statusConnecting :
            styles.statusDisconnected
          ]}>
            {connectionStatus === 'connected' ? '🟢 Connected' :
             connectionStatus === 'connecting' ? '🟡 Connecting...' :
             '🔴 Disconnected'}
          </Text>
        </View>
        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      {currentTransfers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 Transfers</Text>
          {currentTransfers.map((transfer) => (
            <View key={transfer.id} style={styles.transferCard}>
              <Text style={styles.transferTitle}>
                {transfer.direction === 'send' ? '📤' : '📥'} {transfer.fileName}
              </Text>
              <Text style={styles.transferStatus}>
                {transfer.status === 'uploading' ? 'Uploading...' :
                 transfer.status === 'downloading' ? 'Downloading...' :
                 transfer.status === 'completed' ? 'Complete ✅' : 'Failed ❌'}
              </Text>
              <WebProgressBar progress={transfer.progress} />
              <Text style={styles.progressText}>{transfer.progress.toFixed(0)}%</Text>
            </View>
          ))}
        </View>
      )}

      {receivedFiles.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📥 Received ({receivedFiles.length})</Text>
          <FlatList
            data={receivedFiles}
            scrollEnabled={false}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.fileItem}>
                <Text style={styles.fileIcon}>{getFileIcon(item.fileName)}</Text>
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName}>{item.fileName}</Text>
                  <Text style={styles.fileSize}>{formatFileSize(item.fileSize)}</Text>
                </View>
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => openReceivedFile(item)}
                >
                  <Text style={styles.actionButtonText}>Open</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => deleteReceivedFile(item)}
                >
                  <Text style={styles.deleteIcon}>🗑️</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📱 Devices ({devices.length})</Text>
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
              <Text style={styles.deviceIcon}>{getDeviceIcon(item.deviceName)}</Text>
              <Text style={styles.deviceName}>{item.deviceName}</Text>
              <Text style={styles.onlineIndicator}>● Online</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No devices online
            </Text>
          }
        />
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[
            styles.button,
            styles.sendButton,
            (!selectedDevice || loading) && styles.disabledButton,
          ]}
          onPress={() => pickAndSendFiles(false)}
          disabled={!selectedDevice || loading}
        >
          <Text style={styles.buttonText}>📎 Send File</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            styles.multiButton,
            (!selectedDevice || loading) && styles.disabledButton,
          ]}
          onPress={() => pickAndSendFiles(true)}
          disabled={!selectedDevice || loading}
        >
          <Text style={styles.buttonText}>📁 Multiple</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 15,
    paddingTop: Platform.OS === 'web' ? 20 : 50,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#333',
  },
  subtitle: {
    fontSize: 13,
    textAlign: 'center',
    color: '#666',
    marginTop: 4,
  },
  section: {
    marginBottom: 15,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: '#f9f9f9',
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  sendButton: {
    flex: 1,
    marginRight: 8,
  },
  multiButton: {
    flex: 1,
    marginLeft: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  disabledButton: {
    backgroundColor: '#ccc',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  statusText: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
  statusConnected: {
    color: '#34C759',
  },
  statusConnecting: {
    color: '#FF9500',
  },
  statusDisconnected: {
    color: '#FF3B30',
  },
  signOutText: {
    color: '#FF3B30',
    fontSize: 13,
    fontWeight: '600',
  },
  transferCard: {
    backgroundColor: '#E3F2FF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
  },
  transferTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  transferStatus: {
    fontSize: 11,
    color: '#666',
    marginTop: 4,
  },
  webProgressBar: {
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 6,
    overflow: 'hidden',
  },
  webProgressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
  },
  progressText: {
    fontSize: 10,
    color: '#666',
    textAlign: 'right',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
    color: '#333',
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  fileIcon: {
    fontSize: 24,
    marginRight: 10,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  fileSize: {
    fontSize: 10,
    color: '#999',
    marginTop: 2,
  },
  actionButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  deleteIcon: {
    fontSize: 16,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selectedDevice: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FF',
  },
  deviceIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  deviceName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  onlineIndicator: {
    fontSize: 10,
    color: '#34C759',
    fontWeight: '600',
  },
  emptyText: {
    textAlign: 'center',
    color: '#999',
    fontSize: 12,
    paddingVertical: 15,
  },
  buttonRow: {
    flexDirection: 'row',
    marginBottom: 15,
  },
  infoBox: {
    backgroundColor: '#E8F5E9',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4CAF50',
    marginBottom: 20,
  },
  infoHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2E7D32',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 11,
    color: '#2E7D32',
    lineHeight: 18,
  },
});