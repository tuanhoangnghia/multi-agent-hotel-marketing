/**
 * Lớp gọi Video Render Service (Cloud Run) để ghép phụ đề + nhạc nền vào video khách sạn.
 * Render chạy bất đồng bộ (job): submit và poll trạng thái là 2 bước tách rời, vì 1 job có thể
 * mất lâu hơn 6 phút — giới hạn thời gian chạy 1 lần của Apps Script. Poll được thực hiện qua
 * time-trigger lặp lại (giống cơ chế tự resume của runMarketingAutomation trong Orchestrator.gs).
 *
 * Hợp đồng API POST /api/jobs (xác nhận qua /openapi.json thật của service, 2026-08-26): body là
 * application/x-www-form-urlencoded (KHÔNG phải multipart/form-data nữa) với các field:
 *   video_folder_url (string) - link thư mục Drive chứa video nguồn, service tự đọc trong đó
 *   clips (string, JSON, optional) - PHẢI bọc trong {"video_edit_script": [...]}, mỗi phần tử
 *     {"source_video","start","end","vibe_note"} - đúng format video_edit_script do Video Agent
 *     Service sinh ra, không đổi
 *   srt_text (string, optional) - nội dung SRT
 *   intro_text (string, optional) - chưa có nguồn dữ liệu tương ứng trong pipeline hiện tại, để trống
 *   music_url (string, optional) - LINK Drive nhạc nền, không phải blob nữa
 *   options (string, optional) - JSON, để '{"transition": {"enabled": false}}'
 * Không còn field upload blob (video_file/music_file) như bản cũ.
 */

var VIDEO_RENDER_BASE_URL_ = 'https://video-render-service-938843422997.asia-southeast1.run.app';
var VIDEO_RENDER_POLL_TRIGGER_HANDLER_ = 'checkVideoRenderJobs';
var VIDEO_RENDER_POLL_INTERVAL_MINUTES_ = 1;

function videoRenderAuthHeader_() {
  return { Authorization: 'Bearer ' + getVideoRenderApiToken_() };
}

function videoRenderErrorMessage_(body) {
  try {
    var json = JSON.parse(body);
    return json.detail || json.message || body;
  } catch (e) {
    return body;
  }
}

// video_edit_script được lưu trong sheet dưới dạng JSON string (mảng clip). API render lại yêu
// cầu param "clips" là JSON string của 1 OBJECT bọc mảng đó trong key "video_edit_script" -
// không phải gửi thẳng mảng. Trả về null nếu không có script hợp lệ.
function buildVideoRenderClipsParam_(videoEditScriptJson) {
  if (!videoEditScriptJson || String(videoEditScriptJson).trim() === '') {
    return null;
  }
  var editScript;
  try {
    editScript = JSON.parse(videoEditScriptJson);
  } catch (error) {
    throw new Error('video_edit_script trong sheet không phải JSON hợp lệ: ' + error.message);
  }
  return JSON.stringify({ video_edit_script: editScript });
}

function submitVideoRenderJob_(folderUrl, videoEditScriptJson, srtText, musicUrl) {
  var payload = {
    video_folder_url: folderUrl,
    options: '{"transition": {"enabled": false}}', // Đã cập nhật options tại đây
  };
  var clips = buildVideoRenderClipsParam_(videoEditScriptJson);
  if (clips) {
    payload.clips = clips;
  }
  if (srtText) {
    payload.srt_text = srtText;
  }
  if (musicUrl) {
    payload.music_url = musicUrl;
  }

  var response = UrlFetchApp.fetch(VIDEO_RENDER_BASE_URL_ + '/api/jobs', {
    method: 'post',
    headers: videoRenderAuthHeader_(),
    payload: payload, // object thuần (không Blob) -> UrlFetchApp tự gửi application/x-www-form-urlencoded
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code !== 200 && code !== 202) {
    throw new Error('Video Render API lỗi khi tạo job (HTTP ' + code + '): ' + videoRenderErrorMessage_(body));
  }
  return JSON.parse(body).job_id;
}

// output.drive_view_url đã là link đầy đủ (nếu service tự đẩy lên Drive).
// output.download_url chỉ là path tương đối (VD "/api/jobs/{id}/download") -> phải ghép base URL mới bấm được.
function videoRenderResultUrl_(output) {
  if (!output) {
    return '';
  }
  if (output.drive_view_url) {
    return output.drive_view_url;
  }
  if (output.download_url) {
    var path = String(output.download_url);
    return /^https?:\/\//i.test(path) ? path : VIDEO_RENDER_BASE_URL_ + path;
  }
  return '';
}

function getVideoRenderJobStatus_(jobId) {
  var response = UrlFetchApp.fetch(VIDEO_RENDER_BASE_URL_ + '/api/jobs/' + jobId, {
    headers: videoRenderAuthHeader_(),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code !== 200) {
    throw new Error('Video Render API lỗi khi kiểm tra job (HTTP ' + code + '): ' + videoRenderErrorMessage_(body));
  }
  return JSON.parse(body);
}

function ensureVideoRenderPollTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === VIDEO_RENDER_POLL_TRIGGER_HANDLER_;
  });
  if (!exists) {
    ScriptApp.newTrigger(VIDEO_RENDER_POLL_TRIGGER_HANDLER_)
      .timeBased()
      .everyMinutes(VIDEO_RENDER_POLL_INTERVAL_MINUTES_)
      .create();
  }
}

// Hàm điều phối khi submit — KHÔNG BAO GIỜ throw, luôn trả về {status, jobId?}.
// Chỉ còn 1 luồng: cần video_folder_url (thư mục Drive). video_edit_script (nếu có, do Video
// Agent sinh) được gửi làm "clips" để service tự cắt/ghép theo đúng đoạn; nếu chưa có
// video_edit_script thì vẫn submit được (clips để trống - tuỳ service xử lý mặc định thế nào
// với cả thư mục, không phải quyết định của Apps Script).
// Luồng thủ công cũ (video_drive_url = 1 file cụ thể + video_subtitle_srt gõ tay) KHÔNG còn được
// service hỗ trợ — schema mới (/openapi.json) đã bỏ hẳn field upload blob video_file/music_file,
// chỉ còn nhận video_folder_url (thư mục) + music_url (link). Trả lỗi rõ ràng thay vì âm thầm
// gọi API sai field.
function maybeSubmitVideoRenderJob_(hotel) {
  var folderUrl = hotel && hotel['video_folder_url'];

  if (folderUrl && String(folderUrl).trim() !== '') {
    if (!isVideoRenderConfigured_()) {
      return { status: 'skipped: no_video_render_config' };
    }
    try {
      var srtText = hotel['video_srt'] ? String(hotel['video_srt']) : '';
      var musicUrl = hotel['music_drive_url'] ? String(hotel['music_drive_url']) : '';
      var editScriptJson = hotel['video_edit_script'] ? String(hotel['video_edit_script']) : '';

      var jobId = submitVideoRenderJob_(String(folderUrl), editScriptJson, srtText, musicUrl);
      return { status: 'submitted', jobId: jobId };
    } catch (error) {
      console.error('Lỗi submit video render job: ' + error.message);
      return { status: 'error: ' + error.message };
    }
  }

  var legacyVideoUrl = hotel && hotel['video_drive_url'];
  if (!legacyVideoUrl || String(legacyVideoUrl).trim() === '') {
    return { status: 'skipped: no_video' };
  }
  return {
    status: 'error: video_drive_url không còn được Video Render Service hỗ trợ ' +
      '(API mới yêu cầu video_folder_url - đường dẫn thư mục Drive, không nhận upload 1 file video nữa). ' +
      'Đổi cột này sang video_folder_url.',
  };
}

// Chạy định kỳ qua trigger (hoặc bấm tay từ menu "Kiểm tra tiến độ render video")
// để cập nhật trạng thái các job đang chờ xử lý.
function checkVideoRenderJobs() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(getSheetName_());
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return;
  }

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var columnMap = {};
  headers.forEach(function (name, index) { columnMap[name] = index + 1; });

  if (!columnMap['video_render_status'] || !columnMap['video_render_job_id']) {
    return;
  }

  var stillPending = false;

  for (var i = 1; i < values.length; i++) {
    var status = String(values[i][columnMap['video_render_status'] - 1] || '');
    var jobId = String(values[i][columnMap['video_render_job_id'] - 1] || '');
    if (!jobId || (status !== 'submitted' && status !== 'processing')) {
      continue;
    }

    var rowNumber = i + 1;

    try {
      var job = getVideoRenderJobStatus_(jobId);

      if (job.status === 'succeeded') {
        var url = videoRenderResultUrl_(job.output);
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('done');
        sheet.getRange(rowNumber, columnMap['video_render_url']).setValue(url);
        sheet.getRange(rowNumber, columnMap['video_render_at']).setValue(new Date());
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        var message = (job.error && job.error.message) || job.status;
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('error: ' + message);
        sheet.getRange(rowNumber, columnMap['video_render_at']).setValue(new Date());
      } else {
        sheet.getRange(rowNumber, columnMap['video_render_status']).setValue('processing');
        stillPending = true;
      }
    } catch (error) {
      console.error('Lỗi kiểm tra video render job ' + jobId + ': ' + error.message);
      stillPending = true; // có thể chỉ lỗi mạng tạm thời, thử lại ở lần poll sau
    }
  }

  if (!stillPending) {
    deleteExistingTriggers_(VIDEO_RENDER_POLL_TRIGGER_HANDLER_);
  }
}
