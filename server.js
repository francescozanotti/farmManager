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
const syncLogs = {};

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

// Send sync logs to all connected admin clients
function broadcastSyncLogs(hostname, logs) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAdmin) {
      client.send(JSON.stringify({ 
        type: 'syncLogs', 
        hostname: hostname,
        logs: logs
      }));
    }
  });
}


//comp and streaming
// Get available comp files
app.get('/api/comp-files', (req, res) => {
  // Find the main client
  const mainClient = Object.values(connectedClients).find(
    client => getMachineDetails(client.hostname).isMainClient
  );
  
  if (!mainClient) {
    return res.status(404).json({ error: 'Main client not connected' });
  }
  
  // Store the request
  mainClient.pendingCompFilesRequest = res;
  
  // Request comp files from main client
  mainClient.ws.send(JSON.stringify({
    type: 'getCompFiles',
    directoryPath: 'C:/renderfarm'
  }));
  
  // Response will be sent when main client responds
});
  
  // Get available MP4 files
app.get('/api/mp4-files', (req, res) => {
  // Find the main client
  const mainClient = Object.values(connectedClients).find(
    client => getMachineDetails(client.hostname).isMainClient
  );
  
  if (!mainClient) {
    return res.status(404).json({ error: 'Main client not connected' });
  }
  
  // Store the request
  mainClient.pendingMp4FilesRequest = res;
  
  // Request MP4 files from main client
  mainClient.ws.send(JSON.stringify({
    type: 'getMp4Files',
    directoryPath: 'C:/renderfarm/comped'
  }));
  
  // Response will be sent when main client responds
});
  
  // Stream an MP4 file
app.get('/api/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // Find the main client
  const mainClient = Object.values(connectedClients).find(
    client => getMachineDetails(client.hostname).isMainClient
  );
  
  if (!mainClient) {
    return res.status(404).json({ error: 'Main client not connected' });
  }
  
  // Store the streaming request
  mainClient.pendingStreamRequest = res;
  
  // Request stream from main client
  mainClient.ws.send(JSON.stringify({
    type: 'streamFile',
    filePath: 'C:/renderfarm/comped/' + filename
  }));
  
  // Response will be handled when main client responds
});


// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New connection established');
  
  // Flag to identify admin connections (browser) vs render nodes
  ws.isAdmin = false;
  
  ws.on('message', (message) => {
    try {
        const data = JSON.parse(message);
      
        switch(data.type) {

        // Add this case handler in your server.js message handling switch statement:

        case 'requestFileHash':
            // A client is requesting a file hash to compare before sending the full file
            const filePathForHash = data.filePath;
            const requestingClientForHash = data.requestingHost;
            const localHash = data.localHash;
            
            // Find source client
            const sourceClientForHash = Object.values(connectedClients).find(
                client => client.hostname === data.sourceHost
            );
            
            if (sourceClientForHash && sourceClientForHash.ws.readyState === WebSocket.OPEN) {
                sourceClientForHash.ws.send(JSON.stringify({
                    type: 'calculateFileHash',
                    filePath: filePathForHash,
                    requestingHost: requestingClientForHash,
                    localHash: localHash
                }));
            }
            break;
        
        case 'fileHashResult':
            // Forward hash comparison result to the requesting client
            const targetClientForHash = Object.values(connectedClients).find(
                client => client.hostname === data.requestingHost
            );
            
            if (targetClientForHash && targetClientForHash.ws.readyState === WebSocket.OPEN) {
                targetClientForHash.ws.send(JSON.stringify({
                    type: 'fileHashResult',
                    filePath: data.filePath,
                    matches: data.matches
                }));
            
                // If files don't match, initiate a file request
                if (!data.matches) {
                    targetClientForHash.ws.send(JSON.stringify({
                        type: 'hashMismatch',
                        sourcePath: data.filePath,
                        sourceHost: data.sourceHost
                        }));
                }
            }
            break;


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
          
        case 'syncLog':
          const { hostname: syncHost, log: syncLogMessage } = data;
          
          // Initialize logs array if it doesn't exist
          if (!syncLogs[syncHost]) {
            syncLogs[syncHost] = [];
          }
          
          // Add log entry with timestamp
          syncLogs[syncHost].push({
            time: new Date().toISOString(),
            message: syncLogMessage
          });
          
          // Keep only the last 500 log entries
          if (syncLogs[syncHost].length > 500) {
            syncLogs[syncHost] = syncLogs[syncHost].slice(-500);
          }
          
          // Broadcast logs to admin clients
          broadcastSyncLogs(syncHost, syncLogs[syncHost]);
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
          // First sync from the main client to all others
          const mainClient = Object.values(connectedClients).find(
            client => getMachineDetails(client.hostname).isMainClient
          );
          
          if (!mainClient) {
            console.log('Main client (POPPI) not connected, cannot sync');
            // Notify admin UI
            if (ws.isAdmin) {
              ws.send(JSON.stringify({
                type: 'syncLogs',
                hostname: 'SERVER',
                logs: [{
                  time: new Date().toISOString(),
                  message: 'Main client (POPPI) not connected, cannot sync'
                }]
              }));
            }
            break;
          }
          
          console.log(`Starting bi-directional sync for all clients using directory: ${data.directoryPath}`);
          
          // Request file list from every client - we'll do a complete sync in both directions
          Object.values(connectedClients).forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'getFileList',
                directoryPath: data.directoryPath,
                isBidirectional: true
              }));
              
              // Update sync status
              client.syncStatus = 'syncing';
            }
          });
          
          broadcastClients();
          break;
          
        case 'fileList':
          // A client has sent its file list, sync with other clients
          const sourceFiles = data.files;
          const sourcePath = data.directoryPath;
          const sourceHost = data.hostname;
          const isBidirectional = data.isBidirectional || false;
          
          console.log(`Received file list from ${sourceHost} with ${sourceFiles.length} files`);
          
          // Track which clients we need to sync to
          const targetClients = Object.values(connectedClients).filter(client => {
            // Don't sync to self
            if (client.hostname === sourceHost) return false;
            
            // If bidirectional, sync to everyone including main
            if (isBidirectional) return true;
            
            // If not bidirectional, only sync from main to others
            const sourceIsMain = getMachineDetails(sourceHost).isMainClient;
            return sourceIsMain;
          });
          
          // Log the sync operation
          if (ws.isAdmin) {
            ws.send(JSON.stringify({
              type: 'syncLogs',
              hostname: 'SERVER',
              logs: [{
                time: new Date().toISOString(),
                message: `Syncing ${sourceFiles.length} files from ${sourceHost} to ${targetClients.length} clients`
              }]
            }));
          }
          
          // Send files to each target client
          targetClients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify({
                type: 'syncFiles',
                sourceHost: sourceHost,
                files: sourceFiles,
                sourcePath: sourcePath
              }));
              
              console.log(`Sync command sent from ${sourceHost} to ${client.hostname}`);
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
      
        case 'compFiles':
          // Main client is sending list of comp files
            console.log(`Received comp files from ${data.sessionId || 'unknown'}: ${JSON.stringify(data.files)}`);
            
            // Find the client by hostname instead of sessionId
            const clientsWithPendingRequests = Object.values(connectedClients)
              .filter(client => client.pendingCompFilesRequest && client.hostname === data.hostname);
            
            if (clientsWithPendingRequests.length > 0) {
            clientsWithPendingRequests.forEach(client => {
              const response = client.pendingCompFilesRequest;
              response.json({ files: data.files });
              delete client.pendingCompFilesRequest;
            });
          } else {
            console.log('No pending comp file requests found');
          }
          break;
          
        case 'mp4Files':
          // Main client is sending list of MP4 files
          if (connectedClients[data.sessionId] && connectedClients[data.sessionId].pendingMp4FilesRequest) {
            const response = connectedClients[data.sessionId].pendingMp4FilesRequest;
            response.json({ files: data.files });
            delete connectedClients[data.sessionId].pendingMp4FilesRequest;
          }
          break;
        
        case 'streamData':
          // Main client is sending stream data
          if (connectedClients[data.sessionId] && connectedClients[data.sessionId].pendingStreamRequest) {
            const response = connectedClients[data.sessionId].pendingStreamRequest;
            
            if (data.error) {
              response.status(404).json({ error: data.error });
            } else {
              response.set('Content-Type', 'video/mp4');
              response.send(Buffer.from(data.data, 'base64'));
            }
            
            delete connectedClients[data.sessionId].pendingStreamRequest;
          }
          break;
        
        case 'startCompositing':
          // Find main client
          const mainClientComp = Object.values(connectedClients).find(
            client => getMachineDetails(client.hostname).isMainClient
          );
          
          if (!mainClientComp) {
            console.log('Main client not connected, cannot start compositing');
            // Notify admin UI
            if (ws.isAdmin) {
              ws.send(JSON.stringify({
                type: 'renderLogs',
                hostname: 'SERVER',
                logs: [{
                  time: new Date().toISOString(),
                  message: 'Main client (POPPI) not connected, cannot start compositing'
                }]
              }));
            }
            break;
          }
          
          // Forward compositing command to main client
          mainClientComp.ws.send(JSON.stringify({
            type: 'startCompositing',
            compFile: data.compFile
          }));
          
          console.log(`Compositing command sent to ${mainClientComp.hostname}`);
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