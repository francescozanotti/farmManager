const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// Configuration
const renderfarmDirectory = 'C:/renderfarm/';
const serverUrl = 'wss://farmmanager-jcc0.onrender.com/'; // Change to your server address
const reconnectInterval = 5000; // 5 seconds between reconnection attempts

// Generate session ID based on hostname and random string
const hostname = os.hostname();
const sessionId = `${hostname}-${crypto.randomBytes(8).toString('hex')}`;

// Keep track of WebSocket connection
let ws;
let isConnected = false;
let isRendering = false;
let currentRenderProcess = null;
let reconnectTimeout;

// Ensure render directory exists
if (!fs.existsSync(renderfarmDirectory)) {
  try {
    fs.mkdirSync(renderfarmDirectory, { recursive: true });
    console.log(`Created directory ${renderfarmDirectory}`);
  } catch (error) {
    console.error(`Error creating directory: ${error.message}`);
  }
}

// Connect to WebSocket server
function connect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  console.log(`Connecting to server at ${serverUrl}...`);
  
  try {
    ws = new WebSocket(serverUrl);
    
    ws.on('open', () => {
      console.log('Connected to server');
      isConnected = true;
      
      // Register this node with the server
      registerNode();
      
      // Start status update interval
      startStatusUpdates();
    });
    
    ws.on('message', (message) => {
      handleServerMessage(message);
    });
    
    ws.on('error', (error) => {
      console.error(`WebSocket error: ${error.message}`);
    });
    
    ws.on('close', () => {
      console.log('Disconnected from server');
      isConnected = false;
      
      // Schedule reconnection
      reconnectTimeout = setTimeout(connect, reconnectInterval);
    });
  } catch (error) {
    console.error(`Connection error: ${error.message}`);
    reconnectTimeout = setTimeout(connect, reconnectInterval);
  }
}

// Register this node with the server
function registerNode() {
  const files = getDirectoryContents(renderfarmDirectory);
  
  sendMessage({
    type: 'registerNode',
    hostname: hostname,
    sessionId: sessionId,
    files: files,
    directoryPath: renderfarmDirectory
  });
  
  console.log(`Registered as ${hostname} with session ID ${sessionId}`);
}

// Get list of files in a directory (recursive)
function getDirectoryContents(dirPath) {
  try {
    const result = [];
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isFile()) {
        // For files, add relative path and size
        const relativePath = path.relative(renderfarmDirectory, itemPath);
        result.push({
          path: relativePath.replace(/\\/g, '/'),
          size: stats.size,
          mtime: stats.mtime
        });
      } else if (stats.isDirectory()) {
        // For directories, recurse and add results
        const subDirContents = getDirectoryContents(itemPath);
        result.push(...subDirContents);
      }
    }
    
    return result;
  } catch (error) {
    console.error(`Error reading directory ${dirPath}: ${error.message}`);
    return [];
  }
}

// Send status updates to server at regular intervals
function startStatusUpdates() {
  setInterval(() => {
    if (!isConnected) return;
    
    const files = getDirectoryContents(renderfarmDirectory);
    
    sendMessage({
      type: 'nodeStatus',
      sessionId: sessionId,
      hostname: hostname,
      isRendering: isRendering,
      files: files,
      renderProgress: currentRenderProgress
    });
  }, 10000); // Every 10 seconds
}

// Current render progress tracking
let currentRenderProgress = {
  currentFrame: 0,
  totalFrames: 0,
  startTime: null,
  elapsedTime: 0
};

// Handle messages from the server
function handleServerMessage(message) {
  try {
    const data = JSON.parse(message);
    
    switch (data.type) {
      case 'startRender':
        // Start rendering with the specified parameters
        startRender(
          data.houdiniPath,
          data.scenePath,
          data.outputPath,
          data.frames
        );
        break;
        
      case 'stopRender':
        // Stop the current render process
        stopRender();
        break;
        
      case 'getFileList':
        // Server is requesting our file list for sync purposes
        const files = getDirectoryContents(data.directoryPath);
        sendMessage({
          type: 'fileList',
          hostname: hostname,
          directoryPath: data.directoryPath,
          files: files
        });
        break;
        
      case 'syncFiles':
        // Server wants us to sync files from the main client
        syncFilesFromSource(data.sourceHost, data.sourcePath, data.files);
        break;
        
      case 'sendFile':
        // Server wants us to send a file to another client
        sendFileToClient(data.filePath, data.requestingHost);
        break;
        
      case 'receiveFile':
        // Server is forwarding a file from the main client
        saveReceivedFile(data.filePath, data.fileData);
        break;
    }
  } catch (error) {
    console.error(`Error handling message: ${error.message}`);
  }
}

// Sync files from source host
function syncFilesFromSource(sourceHost, sourcePath, files) {
  console.log(`Starting sync from ${sourceHost}`);
  
  // Update sync status
  sendMessage({
    type: 'syncResult',
    sessionId: sessionId,
    success: true,
    message: 'Sync started'
  });
  
  // Create a list to track requested files
  const requestedFiles = new Set();
  
  // Process each file
  for (const file of files) {
    const localPath = path.join(renderfarmDirectory, file.path);
    const localDir = path.dirname(localPath);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(localDir)) {
      try {
        fs.mkdirSync(localDir, { recursive: true });
      } catch (error) {
        console.error(`Error creating directory ${localDir}: ${error.message}`);
        continue;
      }
    }
    
    // Check if we need to request this file
    let needsUpdate = true;
    
    if (fs.existsSync(localPath)) {
      const stats = fs.statSync(localPath);
      
      // If same size and modification time is the same or newer, skip
      if (stats.size === file.size && 
          new Date(stats.mtime) >= new Date(file.mtime)) {
        needsUpdate = false;
      }
    }
    
    if (needsUpdate) {
      // Request the file from source host
      requestedFiles.add(file.path);
      sendMessage({
        type: 'requestFile',
        sourceHost: sourceHost,
        requestingHost: hostname,
        filePath: file.path
      });
    }
  }
  
  // If no files need updating, we're done
  if (requestedFiles.size === 0) {
    console.log('No files need updating');
    sendMessage({
      type: 'syncResult',
      sessionId: sessionId,
      success: true,
      message: 'All files are up to date'
    });
  } else {
    console.log(`Requested ${requestedFiles.size} files for sync`);
  }
}

// Send a file to another client
function sendFileToClient(filePath, requestingHost) {
  const fullPath = path.join(renderfarmDirectory, filePath);
  
  try {
    // Read file as binary data
    const fileData = fs.readFileSync(fullPath);
    
    // Send file data to server (encoded as base64)
    sendMessage({
      type: 'fileData',
      requestingHost: requestingHost,
      filePath: filePath,
      fileData: fileData.toString('base64')
    });
    
    console.log(`Sent file ${filePath} to ${requestingHost}`);
  } catch (error) {
    console.error(`Error sending file ${filePath}: ${error.message}`);
  }
}

// Save a received file
function saveReceivedFile(filePath, fileData) {
  const fullPath = path.join(renderfarmDirectory, filePath);
  const dirPath = path.dirname(fullPath);
  
  try {
    // Ensure directory exists
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    // Write file data (decode from base64)
    fs.writeFileSync(fullPath, Buffer.from(fileData, 'base64'));
    
    console.log(`Saved file ${filePath}`);
    
    // Send sync status update
    sendMessage({
      type: 'syncResult',
      sessionId: sessionId,
      success: true,
      message: `Synced ${filePath}`
    });
  } catch (error) {
    console.error(`Error saving file ${filePath}: ${error.message}`);
    
    sendMessage({
      type: 'syncResult',
      sessionId: sessionId,
      success: false,
      message: `Error saving ${filePath}: ${error.message}`
    });
  }
}

// Start a render process
function startRender(houdiniPath, scenePath, outputPath, frames) {
  if (isRendering) {
    console.log('Already rendering, cannot start new render');
    return;
  }
  
  // Parse frame range
  let frameStart, frameEnd;
  if (typeof frames === 'number') {
    frameStart = frameEnd = frames;
  } else if (Array.isArray(frames) && frames.length === 2) {
    [frameStart, frameEnd] = frames;
  } else {
    console.error('Invalid frame specification');
    return;
  }
  
  console.log(`Starting render with Houdini: ${houdiniPath}`);
  console.log(`Scene: ${scenePath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Frames: ${frameStart} to ${frameEnd}`);
  
  // Reset progress tracking
  currentRenderProgress = {
    currentFrame: frameStart,
    totalFrames: frameEnd - frameStart + 1,
    startTime: Date.now(),
    elapsedTime: 0
  };
  
  // Mark as rendering
  isRendering = true;
  
  // Prepare output directory
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      sendRenderLog(`Error creating output directory: ${error.message}`);
      isRendering = false;
      return;
    }
  }
  
  // Prepare Houdini husk command
  const huskPath = path.join(houdiniPath, 'bin', 'husk.exe');
  
  // Function to render a single frame
  const renderFrame = (frame) => {
    // Format frame number for output path
    const paddedFrame = String(frame).padStart(3, '0');
    const frameOutputPath = outputPath.replace('$F3', paddedFrame);
    
    // Build arguments for husk
    const args = [
      '--verbose', '1',
      '--frame', frame.toString(),
      '--frame-count', '1',
      '--renderer', 'Karma',
      '--output', frameOutputPath,
      scenePath
    ];
    
    sendRenderLog(`Starting frame ${frame} of ${frameEnd}`);
    
    // Spawn the render process
    currentRenderProcess = spawn(huskPath, args);
    
    // Handle process output
    currentRenderProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) sendRenderLog(output);
    });
    
    currentRenderProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output) sendRenderLog(`ERROR: ${output}`);
    });
    
    // Handle process completion
    currentRenderProcess.on('close', (code) => {
      if (code === 0) {
        sendRenderLog(`Frame ${frame} completed successfully`);
      } else {
        sendRenderLog(`Frame ${frame} failed with code ${code}`);
      }
      
      // Update progress
      currentRenderProgress.currentFrame = frame;
      currentRenderProgress.elapsedTime = Date.now() - currentRenderProgress.startTime;
      
      // Move to next frame or finish
      if (frame < frameEnd) {
        renderFrame(frame + 1);
      } else {
        sendRenderLog('Render complete');
        isRendering = false;
        currentRenderProcess = null;
      }
    });
    
    currentRenderProcess.on('error', (err) => {
      sendRenderLog(`Process error: ${err.message}`);
      isRendering = false;
      currentRenderProcess = null;
    });
  };
  
  // Start rendering the first frame
  renderFrame(frameStart);
}

// Stop the current render process
function stopRender() {
  if (!isRendering || !currentRenderProcess) {
    return;
  }
  
  try {
    currentRenderProcess.kill();
    sendRenderLog('Render stopped by user');
  } catch (error) {
    sendRenderLog(`Error stopping render: ${error.message}`);
  }
  
  isRendering = false;
  currentRenderProcess = null;
}

// Send a log message related to rendering
function sendRenderLog(message) {
  console.log(`[RENDER] ${message}`);
  
  sendMessage({
    type: 'renderLog',
    hostname: hostname,
    log: message
  });
}

// Helper function to send a message to the server
function sendMessage(message) {
  if (!isConnected) return;
  
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    console.error(`Error sending message: ${error.message}`);
  }
}

// Start the client
connect();