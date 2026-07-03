// DOM elements
const btnPunchIn = document.getElementById('btn-punch-in');
const btnPunchOut = document.getElementById('btn-punch-out');
const btnCancel = document.getElementById('btn-cancel');
const cancelArea = document.getElementById('cancel-area');
const logsContainer = document.getElementById('logs-container');
const btnClearLogs = document.getElementById('btn-clear-logs');
const statusBadge = document.getElementById('global-status-badge');
const statusText = statusBadge.querySelector('.status-text');

// Credential elements
const inputUserId = document.getElementById('input-user-id');
const inputPassword = document.getElementById('input-password');
const togglePasswordBtn = document.getElementById('toggle-password');
const credentialsBadge = document.getElementById('credentials-badge');

// Screenshot elements
const screenshotContainer = document.getElementById('screenshot-container');
const screenshotPlaceholder = screenshotContainer.querySelector('.screenshot-placeholder');
const screenshotImg = document.getElementById('screenshot-img');

// OTP Modal elements
const otpModal = document.getElementById('otp-modal');
const otpForm = document.getElementById('otp-form');
const otpCodeInput = document.getElementById('otp-code-input');
const btnModalCancel = document.getElementById('btn-modal-cancel');

// State tracking
let pollInterval = null;
let lastLogCount = 0;
let modalOpen = false;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  // Start polling on load to sync with any active automation
  startPolling();
  updateCredentialBadge();
});

// Event Listeners
btnPunchIn.addEventListener('click', () => triggerPunch('in'));
btnPunchOut.addEventListener('click', () => triggerPunch('out'));
btnCancel.addEventListener('click', cancelAutomation);
btnModalCancel.addEventListener('click', cancelAutomation);
btnClearLogs.addEventListener('click', () => {
  logsContainer.innerHTML = '<div class="log-line system-msg">Logs cleared.</div>';
  lastLogCount = 0;
});

// Password toggle
togglePasswordBtn.addEventListener('click', () => {
  const isHidden = inputPassword.type === 'password';
  inputPassword.type = isHidden ? 'text' : 'password';
  togglePasswordBtn.textContent = isHidden ? '🙈' : '👁️';
});

// Update credential badge on input change
inputUserId.addEventListener('input', updateCredentialBadge);
inputPassword.addEventListener('input', updateCredentialBadge);

function updateCredentialBadge() {
  const hasUser = inputUserId.value.trim().length > 0;
  const hasPass = inputPassword.value.trim().length > 0;
  if (hasUser && hasPass) {
    credentialsBadge.textContent = 'Ready';
    credentialsBadge.className = 'credentials-badge ready';
  } else if (hasUser || hasPass) {
    credentialsBadge.textContent = 'Incomplete';
    credentialsBadge.className = 'credentials-badge incomplete';
  } else {
    credentialsBadge.textContent = 'Not Set';
    credentialsBadge.className = 'credentials-badge';
  }
}

// Submit OTP
otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const otp = otpCodeInput.value.trim();
  if (!otp) return;

  try {
    const response = await fetch('/api/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp })
    });
    
    const result = await response.json();
    if (result.success) {
      addLocalLog('Submitted OTP to automation controller. Processing...');
      closeOtpModal();
    } else {
      addLocalLog(`OTP Submission failed: ${result.error}`, 'error');
    }
  } catch (err) {
    addLocalLog(`Network error submitting OTP: ${err.message}`, 'error');
  }
});

// Trigger Punch in/out
async function triggerPunch(action) {
  const userId = inputUserId.value.trim();
  const password = inputPassword.value.trim();

  // Validate credentials before proceeding
  if (!userId || !password) {
    addLocalLog('Please enter both User ID and Password before starting.', 'error');
    // Highlight empty fields
    if (!userId) inputUserId.classList.add('input-error');
    if (!password) inputPassword.classList.add('input-error');
    setTimeout(() => {
      inputUserId.classList.remove('input-error');
      inputPassword.classList.remove('input-error');
    }, 2000);
    return;
  }

  disablePunchButtons(true);
  screenshotImg.style.display = 'none';
  screenshotPlaceholder.style.display = 'block';
  
  addLocalLog(`Starting Punch ${action.toUpperCase()} process...`, 'highlight');
  
  try {
    const response = await fetch('/api/punch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId, password })
    });
    
    const result = await response.json();
    if (result.success) {
      startPolling();
    } else {
      addLocalLog(`Error: ${result.error}`, 'error');
      disablePunchButtons(false);
    }
  } catch (err) {
    addLocalLog(`Failed to communicate with server: ${err.message}`, 'error');
    disablePunchButtons(false);
  }
}

// Cancel active process
async function cancelAutomation() {
  addLocalLog('Sending cancel request...', 'system');
  closeOtpModal();
  
  try {
    const response = await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (result.success) {
      addLocalLog('Automation successfully cancelled.', 'system');
    }
  } catch (err) {
    addLocalLog(`Failed to cancel: ${err.message}`, 'error');
  }
}

// Polling status
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollStatus, 500);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function pollStatus() {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    
    updateStatusBadge(data.state);
    updateLogs(data.logs);
    
    // Manage UI interactive elements based on state
    if (data.isRunning) {
      disablePunchButtons(true);
      cancelArea.style.display = 'block';
    } else {
      disablePunchButtons(false);
      cancelArea.style.display = 'none';
    }
    
    // MFA Handlers
    if (data.state === 'awaiting_otp') {
      openOtpModal();
    } else if (modalOpen) {
      closeOtpModal();
    }
    
    // Success Handler
    if (data.state === 'success') {
      stopPolling();
      if (data.screenshotPath) {
        // Append unique query parameter to bypass browser image cache
        screenshotImg.src = `${data.screenshotPath}?t=${Date.now()}`;
        screenshotImg.style.display = 'block';
        screenshotPlaceholder.style.display = 'none';
      }
    }
    
    // Error Handler
    if (data.state === 'error') {
      stopPolling();
      addLocalLog(`Automation terminated due to error.`, 'error');
    }

    // Stop polling if completely idle
    if (data.state === 'idle' && !data.isRunning) {
      stopPolling();
    }
    
  } catch (err) {
    console.error('Polling error:', err);
  }
}

// Update DOM log elements
function updateLogs(serverLogs) {
  if (!serverLogs || serverLogs.length === 0) return;
  
  // Re-render logs if we missed some
  if (serverLogs.length > lastLogCount) {
    const newLogs = serverLogs.slice(lastLogCount);
    newLogs.forEach(log => {
      const line = document.createElement('div');
      line.className = 'log-line';
      
      // Syntax highlighting check
      if (log.toLowerCase().includes('error')) {
        line.classList.add('error-msg');
      } else if (log.toLowerCase().includes('successfully') || log.toLowerCase().includes('completed')) {
        line.classList.add('success-msg');
      } else if (log.toLowerCase().includes('waiting for') || log.toLowerCase().includes('otp')) {
        line.classList.add('highlight');
      }
      
      line.textContent = log;
      logsContainer.appendChild(line);
    });
    
    lastLogCount = serverLogs.length;
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }
}

function addLocalLog(message, type = 'system') {
  const timestamp = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  
  if (type === 'error') {
    line.classList.add('error-msg');
  } else if (type === 'success') {
    line.classList.add('success-msg');
  } else if (type === 'highlight') {
    line.classList.add('highlight');
  } else {
    line.classList.add('system-msg');
  }
  
  line.textContent = `[${timestamp}] [UI-Local] ${message}`;
  logsContainer.appendChild(line);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Update status badge UI
function updateStatusBadge(state) {
  // Clear classes
  statusBadge.className = 'status-badge ' + state;
  
  switch (state) {
    case 'idle':
      statusText.textContent = 'SYSTEM IDLE';
      break;
    case 'logging_in':
      statusText.textContent = 'AUTHENTICATING';
      break;
    case 'awaiting_otp':
      statusText.textContent = 'OTP INPUT REQUIRED';
      break;
    case 'processing_punch':
      statusText.textContent = 'SUBMITTING PUNCH';
      break;
    case 'success':
      statusText.textContent = 'COMPLETED';
      break;
    case 'error':
      statusText.textContent = 'ERROR DETECTED';
      break;
  }
}

// Enable/Disable buttons
function disablePunchButtons(disable) {
  btnPunchIn.disabled = disable;
  btnPunchOut.disabled = disable;
}

// Modal Handlers
function openOtpModal() {
  if (modalOpen) return;
  modalOpen = true;
  otpCodeInput.value = '';
  otpModal.style.display = 'flex';
  otpCodeInput.focus();
}

function closeOtpModal() {
  if (!modalOpen) return;
  modalOpen = false;
  otpModal.style.display = 'none';
}
