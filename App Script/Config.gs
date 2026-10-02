/**
 * Cấu hình chung cho toàn bộ luồng marketing automation.
 * Các giá trị có thể override qua Project Settings > Script Properties.
 */

var DEFAULT_SHEET_NAME = 'Sheet1';
var DEFAULT_PLATFORMS = ['facebook', 'zalo'];
var DEFAULT_RULES_SHEET_NAME = 'Rules';
var MAX_RUNTIME_MS = 5 * 60 * 1000; // để lại buffer so với giới hạn 6 phút của Apps Script
var STATUS_DONE = 'done';
var STATUS_ERROR_PREFIX = 'error: ';

function getScriptProp_(key, defaultValue) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value === null || value === '' ? defaultValue : value;
}

function getSheetName_() {
  return getScriptProp_('SHEET_NAME', DEFAULT_SHEET_NAME);
}

function getPlatforms_() {
  var raw = getScriptProp_('PLATFORMS', DEFAULT_PLATFORMS.join(','));
  return raw
    .split(',')
    .map(function (p) { return p.trim().toLowerCase(); })
    .filter(Boolean);
}

function getRulesSheetName_() {
  return getScriptProp_('RULES_SHEET_NAME', DEFAULT_RULES_SHEET_NAME);
}

function getFacebookPageId_() {
  var id = getScriptProp_('FB_PAGE_ID', '');
  if (!id) {
    throw new Error('Chưa thiết lập FB_PAGE_ID. Vào menu "🤖 AI Marketing" > "Thiết lập Facebook Page".');
  }
  return id;
}

function getFacebookPageToken_() {
  var token = getScriptProp_('FB_PAGE_ACCESS_TOKEN', '');
  if (!token) {
    throw new Error('Chưa thiết lập FB_PAGE_ACCESS_TOKEN. Vào menu "🤖 AI Marketing" > "Thiết lập Facebook Page".');
  }
  return token;
}

function isFacebookConfigured_() {
  return !!getScriptProp_('FB_PAGE_ID', '') && !!getScriptProp_('FB_PAGE_ACCESS_TOKEN', '');
}

function getVideoRenderApiToken_() {
  var token = getScriptProp_('VIDEO_RENDER_API_TOKEN', '');
  if (!token) {
    throw new Error('Chưa thiết lập VIDEO_RENDER_API_TOKEN. Vào menu "🤖 AI Marketing" > "Thiết lập Video Render API".');
  }
  return token;
}

function isVideoRenderConfigured_() {
  return !!getScriptProp_('VIDEO_RENDER_API_TOKEN', '');
}

function getVideoAgentApiToken_() {
  var token = getScriptProp_('VIDEO_AGENT_API_TOKEN', '');
  if (!token) {
    throw new Error('Chưa thiết lập VIDEO_AGENT_API_TOKEN. Vào menu "🤖 AI Marketing" > "Thiết lập Video Agent API".');
  }
  return token;
}

function isVideoAgentConfigured_() {
  return !!getScriptProp_('VIDEO_AGENT_API_TOKEN', '');
}

// --- Vertex AI (Claude qua Vertex AI Model Garden, billing dồn về GCP - đường duy nhất) ---
// Xem PLAN_vertex_ai_billing_draft.md để biết lý do/cách setup.

function getVertexServiceAccountKey_() {
  var raw = getScriptProp_('VERTEX_SA_KEY_JSON', '');
  if (!raw) {
    throw new Error('Chưa thiết lập VERTEX_SA_KEY_JSON. Vào menu "🤖 AI Marketing" > "Thiết lập Vertex AI (Claude)".');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('VERTEX_SA_KEY_JSON không phải JSON hợp lệ: ' + error.message);
  }
}

function getVertexProjectId_() {
  var id = getScriptProp_('VERTEX_PROJECT_ID', '');
  if (!id) {
    throw new Error('Chưa thiết lập VERTEX_PROJECT_ID. Vào menu "🤖 AI Marketing" > "Thiết lập Vertex AI (Claude)".');
  }
  return id;
}

function getVertexRegion_() {
  return getScriptProp_('VERTEX_REGION', 'us-east5');
}

function getClaudeVertexModel_() {
  // claude-sonnet-4-5 đã xác nhận hoạt động thật trên Vertex AI (xem PLAN_vertex_ai_billing_draft.md).
  // claude-sonnet-5 cũng đã enable nhưng đang chờ Google cấp quota - đổi giá trị này khi sẵn sàng,
  // không cần sửa code.
  return getScriptProp_('CLAUDE_VERTEX_MODEL', 'claude-sonnet-4-5');
}
