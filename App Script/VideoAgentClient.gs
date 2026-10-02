/**
 * Lớp gọi Video Agent Service (Cloud Run) — phân tích toàn bộ video trong 1 thư mục Drive của
 * khách sạn qua Gemini, sinh video_description/video_summary/video_srt/video_edit_script.
 * Cùng pattern async job/poll như VideoRenderClient.gs (submit rồi poll qua trigger, vì phân
 * tích nhiều video có thể mất lâu hơn 6 phút - giới hạn 1 lần chạy của Apps Script).
 *
 * QUAN TRỌNG - khác Video Render: khi hotel có video_folder_url, video_description là nguồn mô
 * tả DUY NHẤT đáng tin cậy (input sheet chỉ chắc chắn có tên KS + giá, các cột thủ công khác có
 * thể trống) - Agent 2-4 (Claude viết persona/brief/content) KHÔNG THỂ chạy có ý nghĩa nếu chưa
 * có video_description. Vì vậy có gateVideoAgentStep_() CHẶN đầu processHotelRow_ (xem
 * Orchestrator.gs): nếu vừa submit job hoặc job đang chạy thì dừng lại luôn trong lượt này,
 * KHÔNG chạy Agent 2-5. checkVideoAgentJobs() sẽ tự chạy tiếp toàn bộ phần còn lại của pipeline
 * (Agent2->3->4->Facebook->Render->Agent5) cho đúng dòng đó ngay khi job succeeded, để không cần
 * người vận hành tự bấm lại "Chạy toàn bộ".
 */

var VIDEO_AGENT_BASE_URL_ = 'https://video-agent-service-938843422997.asia-southeast1.run.app';
var VIDEO_AGENT_POLL_TRIGGER_HANDLER_ = 'checkVideoAgentJobs';
var VIDEO_AGENT_POLL_INTERVAL_MINUTES_ = 1; // ScriptApp.newTrigger(...).timeBased().everyMinutes() CHỈ nhận 1, 5, 10, 15, 30 - không phải số bất kỳ
var VIDEO_AGENT_TARGET_DURATION_SECONDS_ = [30, 60];

function videoAgentAuthHeader_() {
  return { Authorization: 'Bearer ' + getVideoAgentApiToken_() };
}

function videoAgentErrorMessage_(body) {
  try {
    var json = JSON.parse(body);
    return json.detail || json.message || body;
  } catch (e) {
    return body;
  }
}

function submitVideoAgentJob_(hotel) {
  var folderId = extractDriveFolderId_(hotel['video_folder_url']);
  if (!folderId) {
    throw new Error('URL thư mục Drive video không hợp lệ: ' + hotel['video_folder_url']);
  }

  var payload = {
    hotel_id: String(hotel['hotel_id'] || ''),
    folder_id: folderId,
    context: {
      ten_ks: hotel['ten_ks'] || '',
      destination: hotel['destination'] || '',
      gia: hotel['gia'] || '',
      giai_doan: hotel['giai_doan'] || '',
      benefits_raw: hotel['benefits_raw'] || '',
      booking_note: hotel['booking_note'] || '',
      video_style_rules: getVideoStyleRules_() || '',
    },
    target_duration_seconds: VIDEO_AGENT_TARGET_DURATION_SECONDS_,
  };

  var response = UrlFetchApp.fetch(VIDEO_AGENT_BASE_URL_ + '/api/jobs', {
    method: 'post',
    contentType: 'application/json',
    headers: videoAgentAuthHeader_(),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code !== 200 && code !== 202) {
    throw new Error('Video Agent API lỗi khi tạo job (HTTP ' + code + '): ' + videoAgentErrorMessage_(body));
  }
  return JSON.parse(body).job_id;
}

function getVideoAgentJobStatus_(jobId) {
  var response = UrlFetchApp.fetch(VIDEO_AGENT_BASE_URL_ + '/api/jobs/' + jobId, {
    headers: videoAgentAuthHeader_(),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code !== 200) {
    throw new Error('Video Agent API lỗi khi kiểm tra job (HTTP ' + code + '): ' + videoAgentErrorMessage_(body));
  }
  return JSON.parse(body);
}

function ensureVideoAgentPollTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === VIDEO_AGENT_POLL_TRIGGER_HANDLER_;
  });
  if (!exists) {
    ScriptApp.newTrigger(VIDEO_AGENT_POLL_TRIGGER_HANDLER_)
      .timeBased()
      .everyMinutes(VIDEO_AGENT_POLL_INTERVAL_MINUTES_)
      .create();
  }
}

function writeVideoAgentStatus_(sheet, rowNumber, columnMap, status, jobId) {
  if (columnMap['video_agent_status']) {
    sheet.getRange(rowNumber, columnMap['video_agent_status']).setValue(status);
  }
  if (jobId && columnMap['video_agent_job_id']) {
    sheet.getRange(rowNumber, columnMap['video_agent_job_id']).setValue(jobId);
  }
  if (columnMap['video_agent_at']) {
    sheet.getRange(rowNumber, columnMap['video_agent_at']).setValue(new Date());
  }
}

/**
 * Gate ở đầu processHotelRow_ (trước Agent 2) - never-throw, luôn trả về
 * {shouldReturnEarly, hotel}. Khi hotel có video_folder_url và video_description CHƯA sẵn sàng,
 * shouldReturnEarly=true để KHÔNG chạy Agent 2-5 trong lượt này (Claude không có đủ dữ liệu để
 * viết nội dung có ý nghĩa nếu thiếu mô tả từ video).
 */
function gateVideoAgentStep_(sheet, rowNumber, columnMap, hotel) {
  var folderUrl = hotel['video_folder_url'];

  if (!folderUrl || String(folderUrl).trim() === '') {
    // Hotel không dùng luồng video (chỉ dựa cột thủ công / video_drive_url cũ) - không gate.
    writeVideoAgentStatus_(sheet, rowNumber, columnMap, 'skipped: no_video');
    return { shouldReturnEarly: false, hotel: hotel };
  }

  var currentStatus = String(hotel['video_agent_status'] || '').trim();

  if (currentStatus === 'submitted' || currentStatus === 'processing') {
    // Job đang chạy - dừng ở đây, không submit trùng khi runMarketingAutomation quét lại dòng
    // chưa 'done'. checkVideoAgentJobs() sẽ tự chạy tiếp pipeline khi job xong.
    return { shouldReturnEarly: true, hotel: hotel };
  }

  if (currentStatus === 'succeeded') {
    // video_description/video_srt/video_edit_script đã có sẵn trong hotel (đọc từ cột sheet) -
    // chạy tiếp Agent 2 ngay, không cần gọi lại API.
    return { shouldReturnEarly: false, hotel: hotel };
  }

  if (currentStatus.indexOf('error:') === 0 || currentStatus.indexOf('skipped:') === 0) {
    // Video Agent đã lỗi (hoặc bị bỏ qua) từ trước - graceful degradation: chạy tiếp Agent 2-5
    // bằng cột thủ công đang có, không chặn dòng vĩnh viễn chỉ vì 1 job lỗi.
    return { shouldReturnEarly: false, hotel: hotel };
  }

  // currentStatus rỗng - lần đầu thấy dòng này có video_folder_url, submit job mới.
  if (!isVideoAgentConfigured_()) {
    writeVideoAgentStatus_(sheet, rowNumber, columnMap, 'skipped: no_video_agent_config');
    return { shouldReturnEarly: false, hotel: hotel };
  }

  try {
    var jobId = submitVideoAgentJob_(hotel);
    writeVideoAgentStatus_(sheet, rowNumber, columnMap, 'submitted', jobId);
    ensureVideoAgentPollTrigger_();
    return { shouldReturnEarly: true, hotel: hotel };
  } catch (error) {
    console.error('Lỗi submit video agent job: ' + error.message);
    writeVideoAgentStatus_(sheet, rowNumber, columnMap, 'error: ' + error.message);
    // Submit thất bại (vd lỗi mạng/token) - fallback ngay trong lượt này thay vì chặn vĩnh viễn.
    return { shouldReturnEarly: false, hotel: hotel };
  }
}

// Chạy định kỳ qua trigger (hoặc bấm tay từ menu "Kiểm tra tiến độ phân tích video").
// Khi 1 job succeeded: ghi kết quả vào sheet RỒI chạy tiếp luôn phần còn lại của pipeline
// (Agent 2->3->4->Facebook->Video Render->Agent 5) cho đúng dòng đó - vì Agent 2-4 đã bị gate
// chặn ở lượt chạy submit ban đầu, phải có bước này thì dòng đó mới có thể hoàn tất mà không cần
// người vận hành tự bấm lại "Chạy toàn bộ".
function checkVideoAgentJobs() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Một tiến trình khác đang chạy, bỏ qua lần kiểm tra video agent này.');
    return;
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getSheetName_());
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return;
    }

    var headers = values[0].map(function (h) { return String(h).trim(); });
    var columnMap = {};
    headers.forEach(function (name, index) { columnMap[name] = index + 1; });

    if (!columnMap['video_agent_status'] || !columnMap['video_agent_job_id']) {
      return;
    }

    var platforms = getPlatforms_();
    var startTime = new Date().getTime();
    var stillPending = false;

    for (var i = 1; i < values.length; i++) {
      var status = String(values[i][columnMap['video_agent_status'] - 1] || '');
      var jobId = String(values[i][columnMap['video_agent_job_id'] - 1] || '');
      if (!jobId || status !== 'submitted') {
        continue;
      }

      var rowNumber = i + 1;

      try {
        var job = getVideoAgentJobStatus_(jobId);

        if (job.status === 'succeeded') {
          var output = job.output || {};
          sheet.getRange(rowNumber, columnMap['video_agent_status']).setValue('succeeded');
          if (columnMap['video_description']) {
            sheet.getRange(rowNumber, columnMap['video_description']).setValue(output.video_description || '');
          }
          if (columnMap['video_summary']) {
            sheet.getRange(rowNumber, columnMap['video_summary']).setValue(output.video_summary || '');
          }
          if (columnMap['video_srt']) {
            sheet.getRange(rowNumber, columnMap['video_srt']).setValue(output.video_srt || '');
          }
          if (columnMap['video_edit_script']) {
            sheet.getRange(rowNumber, columnMap['video_edit_script']).setValue(JSON.stringify(output.video_edit_script || []));
          }
          sheet.getRange(rowNumber, columnMap['video_agent_at']).setValue(new Date());

          if (new Date().getTime() - startTime > MAX_RUNTIME_MS) {
            // Hết budget thời gian của lượt poll này - dòng đã ở status='succeeded' nên gate sẽ
            // cho qua ngay ở lượt runMarketingAutomation/poll kế tiếp, không mất dữ liệu.
            stillPending = true;
            continue;
          }

          var hotel = {};
          headers.forEach(function (name, index) { hotel[name] = values[i][index]; });
          hotel['video_agent_status'] = 'succeeded';
          hotel['video_description'] = output.video_description || '';
          hotel['video_summary'] = output.video_summary || '';
          hotel['video_srt'] = output.video_srt || '';
          hotel['video_edit_script'] = JSON.stringify(output.video_edit_script || []);

          try {
            runRestOfPipelineForRow_(sheet, rowNumber, columnMap, hotel, platforms);
          } catch (pipelineError) {
            console.error('Lỗi chạy tiếp pipeline sau video agent, dòng ' + rowNumber + ': ' + pipelineError.message);
            saveHotelError_(sheet, rowNumber, columnMap, pipelineError);
          }
        } else if (job.status === 'failed') {
          var message = (job.error && job.error.message) || 'unknown error';
          sheet.getRange(rowNumber, columnMap['video_agent_status']).setValue('error: ' + message);
          sheet.getRange(rowNumber, columnMap['video_agent_at']).setValue(new Date());
          // Không tự chạy tiếp pipeline ở đây - lượt "Chạy toàn bộ danh sách"/"Chạy dòng đang
          // chọn" kế tiếp sẽ tự fallback qua cột thủ công (xem gateVideoAgentStep_, nhánh error:).
        } else {
          stillPending = true; // queued/analyzing/synthesizing - vẫn đang chờ
        }
      } catch (error) {
        console.error('Lỗi kiểm tra video agent job ' + jobId + ': ' + error.message);
        stillPending = true; // có thể chỉ lỗi mạng tạm thời, thử lại ở lần poll sau
      }
    }

    if (!stillPending) {
      deleteExistingTriggers_(VIDEO_AGENT_POLL_TRIGGER_HANDLER_);
    }
  } finally {
    lock.releaseLock();
  }
}
