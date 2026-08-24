const CLOVER_AGENT_SHEET = 'QUEUE';
const CLOVER_AGENT_VERSION = 'v1';

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function secret_() {
  return String(PropertiesService.getScriptProperties().getProperty('CLOVER_AGENT_BRIDGE_SECRET') || '');
}

function authorized_(value) {
  const expected = secret_();
  const received = String(value || '');
  return Boolean(expected) && expected === received;
}

function sheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLOVER_AGENT_SHEET);
  if (!sheet) throw new Error('Aba QUEUE não encontrada.');
  return sheet;
}

function findRowById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const match = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(String(id))
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : 0;
}

function parseContext_(value) {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch (_) {
      return JSON.stringify({ raw: value });
    }
  }
  return JSON.stringify(value);
}

function enqueue_(payload) {
  const id = String(payload.id || '').trim();
  const playerId = String(payload.player_id || '').trim();
  const chatId = String(payload.chat_id || '').trim();
  const question = String(payload.question || '').trim();
  if (!id || !playerId || !chatId || !question) {
    return { ok: false, code: 'invalid_question', error: 'Campos obrigatórios ausentes.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = sheet_();
    const existingRow = findRowById_(sheet, id);
    if (existingRow) {
      const status = String(sheet.getRange(existingRow, 8).getValue() || 'PENDING');
      return { ok: true, duplicate: true, id: id, status: status };
    }

    const now = new Date().toISOString();
    sheet.appendRow([
      id,
      playerId,
      String(payload.player_name || '').trim(),
      chatId,
      now,
      question,
      parseContext_(payload.context_json),
      'PENDING',
      '',
      '',
      '',
      '',
      '',
      CLOVER_AGENT_VERSION,
    ]);
    return { ok: true, duplicate: false, id: id, status: 'PENDING' };
  } finally {
    lock.releaseLock();
  }
}

function answers_(limit) {
  const sheet = sheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, answers: [] };
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const rows = sheet.getRange(2, 1, lastRow - 1, 14).getDisplayValues();
  const answers = [];
  for (let i = 0; i < rows.length && answers.length < safeLimit; i += 1) {
    const row = rows[i];
    if (String(row[7]).trim().toUpperCase() !== 'ANSWERED') continue;
    const answer = String(row[9] || '').trim();
    if (!answer) continue;
    answers.push({
      id: row[0],
      player_id: row[1],
      chat_id: row[3],
      answer: answer,
      answered_at: row[10],
    });
  }
  return { ok: true, answers: answers };
}

function wake_() {
  const sheet = sheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, pending: 0, signature: '' };
  const rows = sheet.getRange(2, 1, lastRow - 1, 8).getDisplayValues();
  const pendingIds = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i][7]).trim().toUpperCase() === 'PENDING') {
      pendingIds.push(String(rows[i][0] || ''));
    }
  }
  return {
    ok: true,
    pending: pendingIds.length,
    signature: pendingIds.slice(0, 20).join('|'),
  };
}

function ackDelivered_(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return { ok: false, code: 'invalid_id', error: 'ID ausente.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sheet = sheet_();
    const row = findRowById_(sheet, cleanId);
    if (!row) return { ok: false, code: 'not_found', error: 'Pergunta não encontrada.' };
    const status = String(sheet.getRange(row, 8).getValue() || '').toUpperCase();
    if (status === 'DELIVERED') {
      return { ok: true, duplicate: true, id: cleanId, status: 'DELIVERED' };
    }
    if (status !== 'ANSWERED') {
      return { ok: false, code: 'invalid_status', error: 'Resposta ainda não está ANSWERED.' };
    }
    sheet.getRange(row, 8).setValue('DELIVERED');
    sheet.getRange(row, 12).setValue(new Date().toISOString());
    return { ok: true, duplicate: false, id: cleanId, status: 'DELIVERED' };
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (!authorized_(params.secret)) return json_({ ok: false, code: 'unauthorized', error: 'Não autorizado.' });
    const action = String(params.action || 'health');
    if (action === 'health') return json_({ ok: true, version: CLOVER_AGENT_VERSION });
    if (action === 'wake') return json_(wake_());
    if (action === 'answers') return json_(answers_(params.limit));
    return json_({ ok: false, code: 'unknown_action', error: 'Ação desconhecida.' });
  } catch (error) {
    return json_({ ok: false, code: 'internal_error', error: String(error && error.message || error) });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!authorized_(payload.secret)) return json_({ ok: false, code: 'unauthorized', error: 'Não autorizado.' });
    const action = String(payload.action || '');
    if (action === 'enqueue') return json_(enqueue_(payload));
    if (action === 'ack_delivered') return json_(ackDelivered_(payload.id));
    return json_({ ok: false, code: 'unknown_action', error: 'Ação desconhecida.' });
  } catch (error) {
    return json_({ ok: false, code: 'internal_error', error: String(error && error.message || error) });
  }
}
