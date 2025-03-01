const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files (index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Machine details with Houdini paths
const machineDetails = {
  "POPPI": { 
    description: "Main Client", 
    houdiniVersions: ["E:/Programmi3D/Houdini 20.5.278/", "E:/Programmi3D/Houdini 19.5.368/"],
    isMainClient: true 
  },
  "DESKTOP-367E3PH": { 
    description: "Work Laptop Andrea", 
    houdiniVersions: ["C:/Program Files/Houdini 18.5.351/"],
    isMainClient: false
  },
  "WorkLaptopAlex": { 
    description: "Work Laptop Alex", 
    houdiniVersions: ["none"],
    isMainClient: false
  }
};

// Storage for connected clients and their render status
const connectedClients = {};
const renderLogs = {};

// Get machine details or provide defaults
function getMachineDetails(hostname) {
  return machineDetails[hostname] || { 
    description: "Unknown Machine", 
    houdiniVersions: [],
    isMainClient: false
  };
}

// Broadcast updated client list to all connected websockets
function broadcastClients() {
  const activeClients = Object.entries(connectedClients).map(([sessionId, client]) => {
    const machineInfo = getMachineDetails(client.hostname);
    
    return {
      hostname: client.hostname,
      sessionId: sessionId,
      description: machineInfo.description,
      houdiniVersions: machineInfo.houdiniVersions,
      isMainClient: machineInfo.isMainClient,
      isRendering: client.isRendering,
      renderProgress: client.renderProgress || {},
      lastSeen: client.lastSeen,
      syncStatus: client.syncStatus || 'unknown',
      files: client.files || []
    };
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        type: 'clientsList', 
        data: activeClients 
      }));
    }
  });
}

// Send render logs to all connected admin clients
function broadcastRenderLogs(hostname, logs) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAdmin) {
      client.send(JSON.stringify({ 
        type: 'renderLogs', 
        hostname: hostname,
        logs: logs
      }));
    }
  });
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New connection established');
  
  // Flag to identify admin connections (browser) vs render nodes
  ws.isAdmin = false;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'adminConnect':
          ws.isAdmin = true;
          console.log('Admin UI connected');
          broadcastClients();
          break;
          
        case 'registerNode':
          const { hostname, sessionId, files, directoryPath } = data;
          
          // Store the connection with client details
          connectedClients[sessionId] = {
            hostname,
            ws,
            isRendering: false,
            lastSeen: Date.now(),
            files: files || [],
            directoryPath,
            syncStatus: 'ready'
          };
          
          console.log(`Node registered: ${hostname} (${sessionId})`);
          broadcastClients();
          break;
          
        case 'nodeStatus':
          if (connectedClients[data.sessionId]) {
            Object.assign(connectedClients[data.sessionId], {
              isRendering: data.isRendering,
              renderProgress: data.renderProgress,
              lastSeen: Date.now(),
              files: data.files || connectedClients[data.sessionId].files
            });
          }
          broadcastClients();
          break;
          
        case 'renderLog':
          const { hostname: renderHost, log } = data;
          
          // Initialize logs array if it doesn't exist
          if (!renderLogs[renderHost]) {
            renderLogs[renderHost] = [];
          }
          
          // Add log entry with timestamp
          renderLogs[renderHost].push({
            time: new Date().toISOString(),
            message: log
          });
          
          // Keep only the last 500 log entries
          if (renderLogs[renderHost].length > 500) {
            renderLogs[renderHost] = renderLogs[renderHost].slice(-500);
          }
          
          // Broadcast logs to admin clients
          broadcastRenderLogs(renderHost, renderLogs[renderHost]);
          break;
          
        case 'syncResult':
          if (connectedClients[data.sessionId]) {
            connectedClients[data.sessionId].syncStatus = data.success ? 'synced' : 'error';
            connectedClients[data.sessionId].lastSyncMessage = data.message;
          }
          broadcastClients();
          break;
          
        case 'startRender':
          // Find client with matching hostname
          const targetClient = Object.values(connectedClients).find(
            client => client.hostname === data.hostname
          );
          
          if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
            // Forward render command to the target client
            targetClient.ws.send(JSON.stringify({
              type: 'startRender',
              houdiniPath: data.houdiniPath,
              outputPath: data.outputPath,
              scenePath: data.scenePath,
              frames: data.frames
            }));
            
            console.log(`Render command sent to ${data.hostname}`);
          } else {
            console.log(`Client ${data.hostname} not found or not connected`);
          }
          break;
          
        case 'syncAllClients':
          // Find the main client (POPPI)
          const mainClient = Object.values(connectedClients).find(
            client => getMachineDetails(client.hostname).isMainClient
          );
          
          if (!mainClient) {
            console.log('Main client (POPPI) not connected, cannot sync');
            break;
          }
          
          // Request file list from main client
          mainClient.ws.send(JSON.stringify({
            type: 'getFileList',
            directoryPath: data.directoryPath
          }));
          break;
          
        case 'fileList':
          // Main client has sent its file list, now sync to other clients
          const sourceFiles = data.files;
          const sourcePath = data.directoryPath;
          
          // For each connected client that's not the main one
          Object.values(connectedClients).forEach(client => {
            const machineInfo = getMachineDetails(client.hostname);
            
            // Skip the main client itself
            if (machineInfo.isMainClient) return;
            
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'syncFiles',
                sourceHost: data.hostname,
                files: sourceFiles,
                sourcePath: sourcePath
              }));
              
              console.log(`Sync command sent to ${client.hostname}`);
              client.syncStatus = 'syncing';
            }
          });
          
          broadcastClients();
          break;
          
        case 'requestFile':
          // A client is requesting a specific file from the main client
          const requestedFile = data.filePath;
          const requestingClient = data.requestingHost;
          
          // Find main client
          const fileSourceClient = Object.values(connectedClients).find(
            client => client.hostname === data.sourceHost
          );
          
          if (fileSourceClient && fileSourceClient.ws.readyState === WebSocket.OPEN) {
            fileSourceClient.ws.send(JSON.stringify({
              type: 'sendFile',
              filePath: requestedFile,
              requestingHost: requestingClient
            }));
          }
          break;
          
        case 'fileData':
          // File data from main client to be forwarded to requesting client
          const targetClientForFile = Object.values(connectedClients).find(
            client => client.hostname === data.requestingHost
          );
          
          if (targetClientForFile && targetClientForFile.ws.readyState === WebSocket.OPEN) {
            targetClientForFile.ws.send(JSON.stringify({
              type: 'receiveFile',
              filePath: data.filePath,
              fileData: data.fileData
            }));
          }
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    // Find and remove the disconnected client
    for (const sessionId in connectedClients) {
      if (connectedClients[sessionId].ws === ws) {
        console.log(`Client disconnected: ${connectedClients[sessionId].hostname}`);
        delete connectedClients[sessionId];
        break;
      }
    }
    
    broadcastClients();
  });
});

// Default route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Render Farm Server running on port ${PORT}`);
});

module.exports = server;