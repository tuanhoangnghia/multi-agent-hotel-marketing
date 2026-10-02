/**
 * Điều phối toàn bộ luồng: Agent 1 -> Agent 2 -> Agent 3 -> Agent 4 -> Agent 5.
 * Tự động resume qua trigger nếu danh sách khách sạn dài hơn giới hạn thời gian chạy.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🤖 AI Marketing')
    .addItem('Chạy toàn bộ danh sách', 'runMarketingAutomation')
    .addItem('Chạy dòng đang chọn', 'runForActiveRow')
    .addSeparator()
    .addItem('Reset trạng thái (chạy lại từ đầu)', 'resetAllStatuses')
    .addItem('Mở sheet Rules & Skills', 'openRulesSheet_')
    .addItem('Thiết lập Facebook Page', 'promptForFacebookPage')
    .addItem('Kiểm tra kết nối Facebook', 'testFacebookConnection')
    .addItem('Thiết lập Video Render API', 'promptForVideoRenderToken')
    .addItem('Kiểm tra tiến độ render video', 'checkVideoRenderJobs')
    .addItem('Thiết lập Video Agent API', 'promptForVideoAgentToken')
    .addItem('Kiểm tra tiến độ phân tích video', 'checkVideoAgentJobs')
    .addSeparator()
    .addItem('Thiết lập Vertex AI (Claude)', 'promptForVertexServiceAccount')
    .addItem('Kiểm tra kết nối Vertex AI (Claude)', 'testVertexConnection')
    .addToUi();
}

function runMarketingAutomation() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Một tiến trình khác đang chạy, bỏ qua lần chạy này.');
    return;
  }

  try {
    deleteExistingTriggers_('runMarketingAutomation');

    var sheetName = getSheetName_();
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Không tìm thấy sheet "' + sheetName + '"');
    }

    var platforms = getPlatforms_();
    var platformColumns = platforms.map(function (p) { return p + '_copy'; });
    var requiredColumns = PRIORITY_COLUMNS_.concat(
      REQUIRED_OUTPUT_COLUMNS_,
      platformColumns, FB_POST_COLUMNS_, FB_INPUT_COLUMNS_,
      VIDEO_RENDER_COLUMNS_, VIDEO_INPUT_COLUMNS_,
      VIDEO_AGENT_OUTPUT_COLUMNS_, VIDEO_AGENT_INPUT_COLUMNS_
    );

    getRulesSheet_(); // đảm bảo sheet "Rules" tồn tại (tự seed mẫu) trước khi các agent đọc rule

    // Agent 1: đọc danh sách khách sạn
    var parsed = readHotelRows_(sheet);
    var columnMap = ensureColumns_(sheet, parsed.headers, requiredColumns);

    var startTime = new Date().getTime();
    var processedCount = 0;
    var hasMore = false;

    for (var i = 0; i < parsed.rows.length; i++) {
      if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
        hasMore = true;
        break;
      }

      var row = parsed.rows[i];

      try {
        processHotelRow_(sheet, row, columnMap, platforms);
        processedCount++;
      } catch (error) {
        console.error('Lỗi xử lý khách sạn tại dòng ' + row.rowNumber + ': ' + error.message);
        saveHotelError_(sheet, row.rowNumber, columnMap, error);
      }
    }

    console.log('Đã xử lý ' + processedCount + '/' + parsed.rows.length + ' khách sạn.');

    if (hasMore) {
      ScriptApp.newTrigger('runMarketingAutomation')
        .timeBased()
        .after(60 * 1000)
        .create();
      console.log('Còn khách sạn chưa xử lý, đã đặt lịch chạy tiếp sau 1 phút.');
    }
  } finally {
    lock.releaseLock();
  }
}

function processHotelRow_(sheet, row, columnMap, platforms) {
  var hotel = row.hotel;
  console.log('Đang xử lý dòng ' + row.rowNumber + ': ' + getHotelName_(hotel));

  // Bước 0: nếu có video_folder_url, video_description là nguồn mô tả BẮT BUỘC phải có trước khi
  // Agent 2 chạy (input sheet chỉ chắc chắn có tên KS + giá, các cột khác có thể trống - Claude
  // không thể viết nội dung có ý nghĩa nếu thiếu mô tả). gateVideoAgentStep_ (VideoAgentClient.gs)
  // chặn ở đây, submit job phân tích video (bất đồng bộ) nếu cần rồi return sớm.
  var gate = gateVideoAgentStep_(sheet, row.rowNumber, columnMap, hotel);
  if (gate.shouldReturnEarly) {
    console.log('Dòng ' + row.rowNumber + ' đang chờ Video Agent phân tích video - tạm dừng, ' +
      'sẽ tự chạy tiếp khi checkVideoAgentJobs() phát hiện job xong.');
    return { pending: true };
  }

  runRestOfPipelineForRow_(sheet, row.rowNumber, columnMap, gate.hotel, platforms);
  return { pending: false };
}

// Phần pipeline chạy sau khi đã có (hoặc xác nhận không cần) video_description: Agent 2->3->4,
// draft Facebook, submit render video, rồi Agent 5 lưu kết quả. Tách riêng để checkVideoAgentJobs()
// (VideoAgentClient.gs) có thể gọi lại đúng logic này ngay khi 1 job phân tích video succeeded,
// thay vì bắt người vận hành tự bấm "Chạy toàn bộ" lần nữa.
function runRestOfPipelineForRow_(sheet, rowNumber, columnMap, hotel, platforms) {
  // Agent 2: chọn buyer persona
  var persona = selectBuyerPersona_(hotel);

  // Agent 3: viết brief chiến dịch
  var brief = writeCampaignBrief_(hotel, persona);

  // Agent 4: chạy sub-agent cho từng nền tảng
  var platformContentMap = runPlatformSubAgents_(hotel, persona, brief, platforms);

  // Tạo draft bài Facebook kèm ảnh Drive (nếu có), không làm hỏng kết quả các bước trên
  var facebookPostResult = null;
  if (platformContentMap.facebook) {
    facebookPostResult = maybePostFacebookDraft_(hotel, platformContentMap.facebook);
  }

  // Submit job render video (nếu có video_drive_url hoặc video_edit_script) — chỉ submit, không
  // chờ render xong vì có thể mất lâu hơn 6 phút; trạng thái cập nhật sau qua trigger checkVideoRenderJobs.
  var videoRenderResult = maybeSubmitVideoRenderJob_(hotel);
  if (videoRenderResult.status === 'submitted') {
    ensureVideoRenderPollTrigger_();
  }

  // Agent 5: lưu nội dung vào sheet
  saveHotelResult_(sheet, rowNumber, columnMap, {
    persona: persona,
    brief: brief,
    platformContentMap: platformContentMap,
    facebookPostResult: facebookPostResult,
    videoRenderResult: videoRenderResult,
  });
}

function runForActiveRow() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getSheetName_());
  var activeRow = sheet.getActiveCell().getRow();

  if (activeRow === 1) {
    SpreadsheetApp.getUi().alert('Vui lòng chọn 1 dòng dữ liệu khách sạn, không phải dòng tiêu đề.');
    return;
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var values = sheet.getRange(activeRow, 1, 1, headers.length).getValues()[0];

  var hotel = {};
  headers.forEach(function (key, index) { hotel[key] = values[index]; });

  var platforms = getPlatforms_();
  var platformColumns = platforms.map(function (p) { return p + '_copy'; });
  var columnMap = ensureColumns_(sheet, headers, PRIORITY_COLUMNS_.concat(
    REQUIRED_OUTPUT_COLUMNS_,
    platformColumns, FB_POST_COLUMNS_, FB_INPUT_COLUMNS_,
    VIDEO_RENDER_COLUMNS_, VIDEO_INPUT_COLUMNS_,
    VIDEO_AGENT_OUTPUT_COLUMNS_, VIDEO_AGENT_INPUT_COLUMNS_
  ));

  getRulesSheet_(); // đảm bảo sheet "Rules" tồn tại (tự seed mẫu) trước khi các agent đọc rule

  try {
    var result = processHotelRow_(sheet, { rowNumber: activeRow, hotel: hotel }, columnMap, platforms);
    if (result && result.pending) {
      SpreadsheetApp.getUi().alert('Dòng ' + activeRow + ' đang chờ Video Agent phân tích video (chạy nền, ' +
        'có thể mất vài phút) - CHƯA sinh nội dung Facebook/Zalo vì cần video_description trước. ' +
        'Pipeline sẽ tự chạy tiếp khi xong - dùng menu "Kiểm tra tiến độ phân tích video" để xem trạng thái.');
    } else {
      SpreadsheetApp.getUi().alert('Đã tạo nội dung cho dòng ' + activeRow + '.');
    }
  } catch (error) {
    saveHotelError_(sheet, activeRow, columnMap, error);
    SpreadsheetApp.getUi().alert('Lỗi: ' + error.message);
  }
}

function resetAllStatuses() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getSheetName_());
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var statusCol = headers.indexOf('status') + 1;

  if (statusCol > 0) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, statusCol, lastRow - 1, 1).clearContent();
    }
  }
}

function deleteExistingTriggers_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
