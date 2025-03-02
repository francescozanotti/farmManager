const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// Configuration
const renderfarmDirectory = 'C:/renderfarm/';
const serverUrl = 'wss://farmmanager-jcc0.onrender.com'; // Change to your server address
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
let pendingFiles = new Set(); // Track files still being synced

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
        sendSyncLog(`Server requested file list for directory: ${data.directoryPath}`);
        const files = getDirectoryContents(data.directoryPath);
        sendMessage({
          type: 'fileList',
          hostname: hostname,
          directoryPath: data.directoryPath,
          files: files,
          isBidirectional: data.isBidirectional
        });
        sendSyncLog(`Sent list of ${files.length} files to server`);
        break;
        
      case 'syncFiles':
        // Server wants us to sync files from another client
        syncFilesFromSource(data.sourceHost, data.sourcePath, data.files);
        break;
        
      case 'sendFile':
        // Server wants us to send a file to another client
        sendFileToClient(data.filePath, data.requestingHost);
        break;
        
      case 'receiveFile':
        // Server is forwarding a file from another client
        saveReceivedFile(data.filePath, data.fileData);
        
        // Check if this was the last file to complete the sync
        if (pendingFiles.has(data.filePath)) {
          pendingFiles.delete(data.filePath);
          
          if (pendingFiles.size === 0) {
            sendSyncLog('Sync complete - all files received');
            sendMessage({
              type: 'syncResult',
              sessionId: sessionId,
              success: true,
              message: 'Sync complete'
            });
          }
        }
        break;
      case 'calculateFileHash':
        // Calculate hash for a file and report if it matches the hash from the requesting client
        calculateAndReturnFileHash(
            data.filePath, 
            data.requestingHost, 
            data.localHash
        );
        break;

      case 'fileHashResult':
        // Results of hash comparison
        sendSyncLog(`Hash comparison for ${data.filePath}: ${data.matches ? 'Matches' : 'Different'}`);
        
        // If files match, we can remove from pendingFiles if it was waiting
        if (data.matches && pendingFiles.has(data.filePath)) {
            pendingFiles.delete(data.filePath);
            sendSyncLog(`File ${data.filePath} is identical, skipping transfer`);
        }
        break;

      case 'hashMismatch':
        // File hashes don't match, request the file
        sendMessage({
            type: 'requestFile',
            sourceHost: data.sourceHost,
            requestingHost: hostname,
            filePath: data.sourcePath
        });
        
        // Add to pending files if not already there
        if (!pendingFiles.has(data.sourcePath)) {
            pendingFiles.add(data.sourcePath);
        }
        
        sendSyncLog(`Requesting ${data.sourcePath} after hash mismatch`);
        break;

      case 'getCompFiles':
        // Server is requesting list of .comp files
        sendSyncLog(`Server requested .comp files from directory: ${data.directoryPath}`);
        const compFiles = getFilesByExtension(data.directoryPath, '.comp');
        sendMessage({
            type: 'compFiles',
            sessionId: sessionId,
            files: compFiles
        });
        sendSyncLog(`Sent list of ${compFiles.length} .comp files to server`);
        break;
        
      case 'getMp4Files':
        // Server is requesting list of MP4 files
        sendSyncLog(`Server requested MP4 files from directory: ${data.directoryPath}`);
        const mp4Files = getFilesByExtension(data.directoryPath, '.mp4');
        sendMessage({
            type: 'mp4Files',
            sessionId: sessionId,
            files: mp4Files
        });
        sendSyncLog(`Sent list of ${mp4Files.length} MP4 files to server`);
        break;
        
      case 'streamFile':
        // Server is requesting to stream a file
        sendSyncLog(`Server requested to stream file: ${data.filePath}`);
        streamFile(data.filePath);
        break;
        
      case 'startCompositing':
        // Start compositing with the specified comp file
        startCompositing(data.compFile);
        break;


    }
  } catch (error) {
    console.error(`Error handling message: ${error.message}`);
    sendSyncLog(`Error: ${error.message}`);
  }
}

// Sync files from source host
function syncFilesFromSource(sourceHost, sourcePath, files) {
    sendSyncLog(`Starting sync from ${sourceHost}`);

    // Update sync status
    sendMessage({
        type: 'syncResult',
        sessionId: sessionId,
        success: true,
        message: 'Sync started'
    });

    // Create a list to track requested files
    const requestedFiles = new Set();
    pendingFiles = new Set(); // Reset pending files

    // Log problematic extensions
    const extensionStats = {};

    // Process each file
    for (const file of files) {
        const localPath = path.join(renderfarmDirectory, file.path);
        const localDir = path.dirname(localPath);
        const fileExt = path.extname(file.path).toLowerCase();
        
        // Track extensions for debugging
        if (!extensionStats[fileExt]) {
        extensionStats[fileExt] = { total: 0, needsUpdate: 0 };
        }
        extensionStats[fileExt].total++;
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(localDir)) {
        try {
            fs.mkdirSync(localDir, { recursive: true });
            sendSyncLog(`Created directory: ${localDir}`);
        } catch (error) {
            sendSyncLog(`Error creating directory ${localDir}: ${error.message}`);
            continue;
        }
        }
        
        // Check if we need to request this file - ONLY COMPARE SIZE
        let needsUpdate = true;
        let skipReason = "File doesn't exist locally";
        
        if (fs.existsSync(localPath)) {
        try {
            const stats = fs.statSync(localPath);
            
            // Debug problematic file types
            if (fileExt === '.hiplc' || fileExt === '.usd') {
            sendSyncLog(`File comparison for ${file.path}: Local size=${stats.size}, Remote size=${file.size}`);
            }
            
            // If same size, skip (not checking modification time)
            if (stats.size === file.size) {
            needsUpdate = false;
            skipReason = "Same size";
            } else {
            skipReason = `Different size: local=${stats.size}, remote=${file.size}`;
            }
        } catch (error) {
            sendSyncLog(`Error comparing file ${localPath}: ${error.message}`);
            skipReason = "Error reading local file";
        }
        }
        
        // Special handling for .hiplc and .usd files - force to use exact byte comparison
        if (needsUpdate && (fileExt === '.hiplc' || fileExt === '.usd') && fs.existsSync(localPath)) {
        try {
            // For these problematic files, do a more thorough check
            const localContent = fs.readFileSync(localPath);
            const localHash = crypto.createHash('md5').update(localContent).digest('hex');
            sendSyncLog(`Special handling for ${file.path}: Using hash comparison`);
            
            // Request file hash instead of the full file
            sendMessage({
            type: 'requestFileHash',
            sourceHost: sourceHost,
            requestingHost: hostname,
            filePath: file.path,
            localHash: localHash
            });
            
            // We'll decide later if we need the file, once we get the hash response
            needsUpdate = false;
            skipReason = "Using hash comparison instead";
        } catch (error) {
            sendSyncLog(`Error in special handling for ${file.path}: ${error.message}`);
        }
        }
        
        if (needsUpdate) {
        // Request the file from source host
        requestedFiles.add(file.path);
        pendingFiles.add(file.path); // Track pending files
        
        extensionStats[fileExt].needsUpdate++;
        
        sendMessage({
            type: 'requestFile',
            sourceHost: sourceHost,
            requestingHost: hostname,
            filePath: file.path
        });
        } else if (fileExt === '.hiplc' || fileExt === '.usd') {
        sendSyncLog(`Skipped ${file.path}: ${skipReason}`);
        }
    }

    // Log stats by extension
    sendSyncLog("Sync statistics by extension:");
    for (const ext in extensionStats) {
        sendSyncLog(`${ext}: ${extensionStats[ext].needsUpdate} of ${extensionStats[ext].total} files need update`);
    }

    // If no files need updating, we're done
    if (requestedFiles.size === 0) {
        sendSyncLog('No files need updating - sync complete');
        sendMessage({
        type: 'syncResult',
        sessionId: sessionId,
        success: true,
        message: 'All files are up to date'
        });
    } else {
        sendSyncLog(`Requested ${requestedFiles.size} files for sync`);
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
    
    sendSyncLog(`Sent file ${filePath} to ${requestingHost}`);
  } catch (error) {
    sendSyncLog(`Error sending file ${filePath}: ${error.message}`);
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
      sendSyncLog(`Created directory: ${dirPath}`);
    }
    
    // Write file data (decode from base64)
    fs.writeFileSync(fullPath, Buffer.from(fileData, 'base64'));
    
    sendSyncLog(`Saved file: ${filePath}`);
    
    // Send sync status update
    sendMessage({
      type: 'syncResult',
      sessionId: sessionId,
      success: true,
      message: `Synced ${filePath}`
    });
  } catch (error) {
    sendSyncLog(`Error saving file ${filePath}: ${error.message}`);
    
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

// Send a log message related to file syncing
function sendSyncLog(message) {
  console.log(`[SYNC] ${message}`);
  
  sendMessage({
    type: 'syncLog',
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

function calculateAndReturnFileHash(filePath, requestingHost, localHash) {
    const fullPath = path.join(renderfarmDirectory, filePath);

    try {
        if (!fs.existsSync(fullPath)) {
        // File doesn't exist, so definitely doesn't match
        sendMessage({
            type: 'fileHashResult',
            requestingHost: requestingHost,
            filePath: filePath,
            matches: false,
            sourceHost: hostname
        });
        return;
        }
        
        // Read file and calculate hash
        const fileContent = fs.readFileSync(fullPath);
        const fileHash = crypto.createHash('md5').update(fileContent).digest('hex');
        
        // Compare with provided hash
        const matches = (fileHash === localHash);
        
        sendMessage({
        type: 'fileHashResult',
        requestingHost: requestingHost,
        filePath: filePath,
        matches: matches,
        sourceHost: hostname
        });
        
        sendSyncLog(`Calculated hash for ${filePath}: ${matches ? 'Matches' : 'Different'} from requester`);
    } catch (error) {
        sendSyncLog(`Error calculating hash for ${filePath}: ${error.message}`);
        
        // Report as not matching on error
        sendMessage({
        type: 'fileHashResult',
        requestingHost: requestingHost,
        filePath: filePath,
        matches: false,
        sourceHost: hostname
        });
    }
}

//compositing and streaming

// Get files with specific extension from a directory
function getFilesByExtension(dirPath, extension) {
  try {
    const result = [];
    
    if (!fs.existsSync(dirPath)) {
      return result;
    }
    
    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isFile() && path.extname(item).toLowerCase() === extension.toLowerCase()) {
        result.push({
          filename: item,
          path: itemPath,
          size: stats.size,
          mtime: stats.mtime
        });
      }
    }
    
    return result;
  } catch (error) {
    console.error(`Error reading directory ${dirPath}: ${error.message}`);
    return [];
  }
}
  
// Stream a file to the server
function streamFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      sendMessage({
        type: 'streamData',
        sessionId: sessionId,
        error: 'File not found'
      });
      return;
    }
    
    // Read file as binary data
    const fileData = fs.readFileSync(filePath);
    
    // Send file data to server (encoded as base64)
    sendMessage({
      type: 'streamData',
      sessionId: sessionId,
      data: fileData.toString('base64')
    });
    
    sendSyncLog(`Streamed file ${filePath} to server`);
  } catch (error) {
    sendSyncLog(`Error streaming file ${filePath}: ${error.message}`);
    sendMessage({
      type: 'streamData',
      sessionId: sessionId,
      error: error.message
    });
  }
}
  
  // Start the compositing process
function startCompositing(compFile) {
  if (isRendering) {
    sendRenderLog('Already rendering, cannot start compositing');
    return;
  }
  
  sendRenderLog(`Starting compositing for: ${compFile}`);
  
  // Mark as rendering
  isRendering = true;
  
  // Ensure output directory exists
  const outputDir = path.join(renderfarmDirectory, 'comped');
  if (!fs.existsSync(outputDir)) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      sendRenderLog(`Error creating output directory: ${error.message}`);
      isRendering = false;
      return;
    }
  }
  
  // Extract frames from comp filename (assuming format like "sequence1-10.comp")
  let startFrame = 1;
  let endFrame = 10;
  const match = compFile.match(/sequence(\d+)-(\d+)\.comp/i);
  if (match) {
    startFrame = parseInt(match[1]);
    endFrame = parseInt(match[2]);
  }
  
  // Prepare the PowerShell command
  const compFilePath = path.join(renderfarmDirectory, compFile);
  const sequenceName = path.basename(compFile, '.comp');
  
  // PowerShell script
  const psScript = `
    $renderNodePath = "C:\\Program Files\\Blackmagic Design\\Fusion Render Node 18\\FusionRenderNode.exe"
    $compFile = "${compFilePath.replace(/\\/g, '\\\\')}"
    $startFrame = ${startFrame}
    $endFrame = ${endFrame}
    $outputDir = "${outputDir.replace(/\\/g, '\\\\')}"
    $outputFile = Join-Path $outputDir "${sequenceName}.mp4"

    Write-Output "Starting compositing for $compFile"
    Write-Output "Frame range: $startFrame to $endFrame"
    
    # Delete old MP4 output if it exists
    if (Test-Path -Path $outputFile) {
        Write-Output "Removing existing output file..."
        Remove-Item -Path $outputFile -Force
    }
    
    # Construct the Fusion render command
    $arguments = @(
        "\`"$compFile\`"",
        "/render",
        "/start $startFrame",
        "/end $endFrame",
        "/frames $startFrame-$endFrame",
        "/verbose",
        "/quit"
    )
    
    # Execute Fusion Render Node
    Write-Output "Running Fusion Render Node..."
    & "$renderNodePath" $arguments
    
    # Check if MP4 file was created
    if (Test-Path -Path $outputFile) {
        Write-Output "Compositing completed: $outputFile"
    } else {
        Write-Output "Error: Fusion did not create output MP4! Check Saver node settings."
    }
  `;
  
  // Create a temporary ps1 script file
  const scriptPath = path.join(os.tmpdir(), `compose_${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, psScript);
  
  // Execute PowerShell script
  const process = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
  
  // Handle process output
  process.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) sendRenderLog(output);
  });
  
  process.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) sendRenderLog(`ERROR: ${output}`);
  });
  
  // Handle process completion
  process.on('close', (code) => {
    if (code === 0) {
      sendRenderLog(`Compositing completed successfully`);
    } else {
      sendRenderLog(`Compositing failed with code ${code}`);
    }
    
    // Clean up temp script
    try {
      fs.unlinkSync(scriptPath);
    } catch (err) {
      console.error(`Error removing temp script: ${err.message}`);
    }
    
    isRendering = false;
  });
  
  process.on('error', (err) => {
    sendRenderLog(`Process error: ${err.message}`);
    isRendering = false;
  });
}

// Start the client
connect();