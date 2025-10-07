import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import sessionManager from "../services/sessionManager";

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000';
console.log('🔌 WebSocket URL:', WS_URL);


const RECONNECT_INTERVAL = 5000; // 5 seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const FALLBACK_FETCH_INTERVAL = 10000; // 10 seconds

const useAdminWebSocket = (user) => {
  const ws = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [newStudyCount, setNewStudyCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'disconnected', 'connecting', 'connected', 'error'
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectTimeout = useRef(null);
  const fallbackInterval = useRef(null);

  const connect = () => {
    if (!user || user.role !== 'admin') {
      console.log('❌ WebSocket connection skipped: User is not admin or not logged in');
      return;
    }

    setConnectionStatus('connecting');
    const token = sessionManager.getToken();
    console.log('🔑 Using token for WebSocket:', token);
    // Since we're using cookies, the browser will automatically send them with the WebSocket connection
    const wsUrl = `${WS_URL}/ws/admin${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    console.log('🔌 WebSocket URL:', wsUrl);
    
    try {
      console.log('🔌 Attempting to connect to WebSocket...');
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        console.log('✅ Admin WebSocket connected successfully');
        setIsConnected(true);
        setConnectionStatus('connected');
        reconnectAttempts.current = 0;
        
        // Clear any existing reconnect timeout
        if (reconnectTimeout.current) {
          clearTimeout(reconnectTimeout.current);
          reconnectTimeout.current = null;
        }
        
        // Clear fallback interval if it was set
        if (fallbackInterval.current) {
          clearInterval(fallbackInterval.current);
          fallbackInterval.current = null;
        }
        
        // Subscribe to study notifications
        setTimeout(() => {
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              type: 'subscribe_to_studies'
            }));
          }
        }, 100);
      };

      ws.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.current.onclose = (event) => {
        console.log('❌ Admin WebSocket disconnected:', event.code, event.reason);
        setIsConnected(false);
        setConnectionStatus('disconnected');
        
        // Attempt to reconnect if not manually closed
        // if (event.code !== 1000 && reconnectAttempts.current < maxReconnectAttempts) {
        //   reconnectAttempts.current++;
        //   const delay = Math.min(3000 * reconnectAttempts.current, 30000); // Max 30 seconds
        //   console.log(`🔄 Attempting to reconnect in ${delay/1000}s... (${reconnectAttempts.current}/${maxReconnectAttempts})`);
          
        //   setConnectionStatus('connecting');
        //   reconnectTimeout.current = setTimeout(() => connect(), delay);
        // } else if (reconnectAttempts.current >= maxReconnectAttempts) {
        //   console.log('❌ Max reconnection attempts reached');
        //   setConnectionStatus('error');
        //   toast.error('Failed to connect to real-time notifications. Please refresh the page.', {
        //     duration: 8000
        //   });
        // }
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('error');
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
      setConnectionStatus('error');
    }
  };

  const handleMessage = (message) => {
    switch (message.type) {
      case 'connection_established':
        console.log('🎉 WebSocket connection established:', message.userInfo);
        toast.success(`Connected to real-time notifications as ${message.userInfo.name}`, { 
          duration: 3000,
          icon: '🔔'
        });
        break;
        
      case 'subscribed_to_studies':  // Updated from 'subscribed'
        console.log('📋 Subscribed to study notifications');
        break;
        
      // 🔧 FIX: Change from 'new_study' to 'new_study_notification'
      case 'new_study_notification':
        const study = message.data;
        setNewStudyCount(prev => prev + 1);
        
        // Show notification toast with medical icon and series/instance info
        const seriesInfo = study.seriesImages ? ` • ${study.seriesImages} Ser/Inst` : '';
        toast.success(
          `New Study: ${study.patientName}${seriesInfo}`,
          {
            duration: 6000,
            icon: '🏥',
            style: {
              background: 'linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%)',
              border: '2px solid #22c55e',
              color: '#065f46',
              fontWeight: '600'
            }
          }
        );
        
        // Show additional details in a separate toast
        setTimeout(() => {
          toast(`📋 ${study.modality} • 📍 ${study.location} • 🆔 ${study.patientId}`, {
            duration: 4000,
            style: {
              background: 'linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%)',
              border: '1px solid #3b82f6',
              color: '#1e3a8a',
            }
          });
        }, 500);
        break;
        
      case 'study_status_change':
        const statusChange = message.data;
        toast(`Status Update: ${statusChange.patientName} - ${statusChange.newStatus}`, {
          duration: 4000,
          icon: '🔄',
          style: {
            background: 'linear-gradient(135deg, #fffbeb 0%, #fefce8 100%)',
            border: '1px solid #f59e0b',
            color: '#78350f',
          }
        });
        break;
        
      case 'pong':
        // Heartbeat response - just log for debugging
        console.log('💓 Received heartbeat pong');
        break;
        
      // Add this case in the handleMessage function switch statement
      case 'simple_new_study_notification':
        setNewStudyCount(prev => prev + 1);
        
        toast('New Study Arrived', {
          duration: 4000,
          icon: '🏥',
          style: {
            background: 'linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%)',
            border: '2px solid #22c55e',
            color: '#065f46',
            fontWeight: '600'
          }
        });
        break;
        
      default:
        console.log('Unknown message type:', message.type);
    }
  };

  const sendHeartbeat = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'ping' }));
    }
  };

  const disconnect = () => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    
    if (fallbackInterval.current) {
      clearInterval(fallbackInterval.current);
      fallbackInterval.current = null;
    }
    
    if (ws.current) {
      ws.current.close(1000, 'Manual disconnect');
    }
    
    setIsConnected(false);
    setConnectionStatus('disconnected');
    reconnectAttempts.current = 0;
  };

  useEffect(() => {
    if (user && user.role === 'admin') {
      connect();

      // Send heartbeat every 30 seconds
      const heartbeatInterval = setInterval(sendHeartbeat, 30000);

      return () => {
        clearInterval(heartbeatInterval);
        disconnect();
      };
    } else {
      console.log('❌ WebSocket not initialized: User is not admin or not logged in');
      setConnectionStatus('disconnected');
    }
  }, [user]);

  return {
    isConnected,
    connectionStatus,
    newStudyCount,
    resetNewStudyCount: () => setNewStudyCount(0),
    reconnect: connect,
    disconnect
  };
};

export default useAdminWebSocket;