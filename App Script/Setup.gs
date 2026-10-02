/**
 * Thiết lập cấu hình qua menu, lưu vào Script Properties (không lưu trong code).
 */

function promptForFacebookPage() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var idResult = ui.prompt('Thiết lập Facebook Page (1/2)', 'Dán Facebook Page ID:', ui.ButtonSet.OK_CANCEL);
  if (idResult.getSelectedButton() !== ui.Button.OK) {
    return;
  }
  var pageId = idResult.getResponseText().trim();
  if (!pageId) {
    ui.alert('Page ID trống, chưa lưu.');
    return;
  }

  var tokenResult = ui.prompt('Thiết lập Facebook Page (2/2)', 'Dán Page Access Token (nên dùng long-lived token):', ui.ButtonSet.OK_CANCEL);
  if (tokenResult.getSelectedButton() !== ui.Button.OK) {
    return;
  }
  var pageToken = tokenResult.getResponseText().trim();
  if (!pageToken) {
    ui.alert('Access Token trống, chưa lưu.');
    return;
  }

  props.setProperty('FB_PAGE_ID', pageId);
  props.setProperty('FB_PAGE_ACCESS_TOKEN', pageToken);

  try {
    var page = fbValidatePageToken_(pageId, pageToken);
    ui.alert('Đã lưu và xác thực thành công. Trang: ' + page.name);
  } catch (error) {
    ui.alert('Đã lưu nhưng xác thực thất bại: ' + error.message +
      '\n\nKiểm tra lại Page ID / Access Token, hoặc chạy "Kiểm tra kết nối Facebook" sau khi sửa.');
  }
}

function testFacebookConnection() {
  var ui = SpreadsheetApp.getUi();
  try {
    var page = fbValidatePageToken_(getFacebookPageId_(), getFacebookPageToken_());
    ui.alert('Kết nối OK. Trang: ' + page.name + ' (ID: ' + page.id + ')');
  } catch (error) {
    ui.alert('Kết nối lỗi: ' + error.message);
  }
}

function promptForVideoRenderToken() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Thiết lập Video Render API', 'Dán Bearer Token của Video Render API:', ui.ButtonSet.OK_CANCEL);

  if (result.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var token = result.getResponseText().trim();
  if (!token) {
    ui.alert('Token trống, chưa lưu.');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('VIDEO_RENDER_API_TOKEN', token);
  ui.alert('Đã lưu Video Render API Token.');
}

function promptForVideoAgentToken() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('Thiết lập Video Agent API', 'Dán Bearer Token của Video Agent API:', ui.ButtonSet.OK_CANCEL);

  if (result.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var token = result.getResponseText().trim();
  if (!token) {
    ui.alert('Token trống, chưa lưu.');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('VIDEO_AGENT_API_TOKEN', token);
  ui.alert('Đã lưu Video Agent API Token.');
}

function promptForVertexServiceAccount() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var projectResult = ui.prompt('Thiết lập Vertex AI - Claude (1/3)', 'Dán GCP Project ID (vd: bof-intern):', ui.ButtonSet.OK_CANCEL);
  if (projectResult.getSelectedButton() !== ui.Button.OK) return;
  var projectId = projectResult.getResponseText().trim();
  if (!projectId) {
    ui.alert('Project ID trống, chưa lưu.');
    return;
  }

  var keyResult = ui.prompt(
    'Thiết lập Vertex AI - Claude (2/3)',
    'Dán TOÀN BỘ nội dung file JSON key của service account (minify về 1 dòng trước khi dán):',
    ui.ButtonSet.OK_CANCEL
  );
  if (keyResult.getSelectedButton() !== ui.Button.OK) return;
  var keyJson = keyResult.getResponseText().trim();
  if (!keyJson) {
    ui.alert('Key JSON trống, chưa lưu.');
    return;
  }

  try {
    var parsedKey = JSON.parse(keyJson);
    if (!parsedKey.client_email || !parsedKey.private_key) {
      throw new Error('Thiếu client_email hoặc private_key trong JSON.');
    }
  } catch (error) {
    ui.alert('JSON không hợp lệ: ' + error.message);
    return;
  }

  var regionResult = ui.prompt(
    'Thiết lập Vertex AI - Claude (3/3)',
    'Region Vertex AI (bỏ trống để dùng mặc định us-east5):',
    ui.ButtonSet.OK_CANCEL
  );
  if (regionResult.getSelectedButton() !== ui.Button.OK) return;
  var region = regionResult.getResponseText().trim();

  props.setProperty('VERTEX_PROJECT_ID', projectId);
  props.setProperty('VERTEX_SA_KEY_JSON', keyJson);
  if (region) {
    props.setProperty('VERTEX_REGION', region);
  }
  CacheService.getScriptCache().remove('VERTEX_ACCESS_TOKEN');

  ui.alert('Đã lưu cấu hình Vertex AI. Từ giờ Claude sẽ gọi qua Vertex AI (billing GCP) thay vì ' +
    'Anthropic API trực tiếp.\n\nDùng menu "Kiểm tra kết nối Vertex AI (Claude)" để test.');
}

function testVertexConnection() {
  var ui = SpreadsheetApp.getUi();
  try {
    var reply = callClaudeViaVertex_('Bạn là trợ lý kiểm tra kết nối.', 'Trả lời đúng 1 từ: OK', 16);
    ui.alert('Kết nối Vertex AI OK. Claude trả lời: ' + reply);
  } catch (error) {
    ui.alert('Kết nối lỗi: ' + error.message);
  }
}
