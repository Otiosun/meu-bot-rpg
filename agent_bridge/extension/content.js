(() => {
  const DEFAULT_POLL_MS = 5000;
  const RETRY_SAME_SIGNATURE_MS = 180000;
  const WAKE_TEXT = [
    'CLOVER_AGENT_WAKE_V1',
    'Há mensagens PENDING na planilha CLOVER_AGENT_QUEUE_POC.',
    'Leia a fila, processe as pendentes com o contexto canônico disponível, escreva cada resposta na coluna answer, preencha answered_at e mude status para ANSWERED.',
    'Não responda ao jogador apenas neste chat: a saída operacional precisa ficar registrada na planilha.'
  ].join('\n');

  let timer = null;
  let inFlight = false;
  let lastSignature = '';
  let lastSentAt = 0;

  function composer() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('div[contenteditable="true"]');
  }

  function sendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[aria-label*="Enviar"]');
  }

  function stopButtonVisible() {
    return Boolean(
      document.querySelector('button[data-testid="stop-button"]')
      || document.querySelector('button[aria-label*="Stop"]')
      || document.querySelector('button[aria-label*="Parar"]')
    );
  }

  function setComposerText(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  async function settings() {
    return chrome.storage.local.get({
      bridgeUrl: '',
      bridgeSecret: '',
      conversationUrl: '',
      pollMs: DEFAULT_POLL_MS,
      enabled: false,
    });
  }

  async function wakeStatus(config) {
    const url = new URL(config.bridgeUrl);
    url.searchParams.set('action', 'wake');
    url.searchParams.set('secret', config.bridgeSecret);
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'wake_failed');
    return payload;
  }

  function onTargetConversation(config) {
    if (!config.conversationUrl) return true;
    try {
      const target = new URL(config.conversationUrl);
      const current = new URL(location.href);
      return target.origin === current.origin && target.pathname === current.pathname;
    } catch {
      return false;
    }
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const config = await settings();
      if (!config.enabled || !config.bridgeUrl || !config.bridgeSecret) return;
      if (!onTargetConversation(config)) return;
      if (stopButtonVisible()) return;

      const state = await wakeStatus(config);
      const pending = Number(state.pending || 0);
      const signature = String(state.signature || '');
      if (!pending || !signature) {
        lastSignature = '';
        return;
      }

      const now = Date.now();
      const sameSignatureRecentlySent = signature === lastSignature
        && (now - lastSentAt) < RETRY_SAME_SIGNATURE_MS;
      if (sameSignatureRecentlySent) return;

      const input = composer();
      if (!input) return;
      setComposerText(input, WAKE_TEXT);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const button = sendButton();
      if (!button || button.disabled) return;
      button.click();
      lastSignature = signature;
      lastSentAt = now;
    } catch (error) {
      console.warn('[clover-agent-extension]', error?.message || error);
    } finally {
      inFlight = false;
    }
  }

  async function start() {
    const config = await settings();
    const pollMs = Math.max(3000, Number(config.pollMs) || DEFAULT_POLL_MS);
    if (timer) clearInterval(timer);
    timer = setInterval(tick, pollMs);
    tick();
  }

  chrome.storage.onChanged.addListener(() => start());
  start();
})();
