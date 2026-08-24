async function load() {
  const config = await chrome.storage.local.get({
    bridgeUrl: '',
    bridgeSecret: '',
    conversationUrl: '',
    pollMs: 5000,
    enabled: false,
  });
  for (const key of ['bridgeUrl', 'bridgeSecret', 'conversationUrl', 'pollMs', 'enabled']) {
    const element = document.getElementById(key);
    if (element.type === 'checkbox') element.checked = Boolean(config[key]);
    else element.value = config[key];
  }
}

async function save() {
  const config = {
    bridgeUrl: document.getElementById('bridgeUrl').value.trim(),
    bridgeSecret: document.getElementById('bridgeSecret').value.trim(),
    conversationUrl: document.getElementById('conversationUrl').value.trim(),
    pollMs: Math.max(3000, Number(document.getElementById('pollMs').value) || 5000),
    enabled: document.getElementById('enabled').checked,
  };
  await chrome.storage.local.set(config);
  const status = document.getElementById('status');
  status.textContent = 'Salvo.';
  setTimeout(() => { status.textContent = ''; }, 1500);
}

document.getElementById('save').addEventListener('click', save);
load();
