from app.schemas import CreateJobRequest, JobStatusResponse


def test_create_job_request_defaults():
    req = CreateJobRequest(hotel_id="H001", folder_id="abc123")
    assert req.target_duration_seconds == [30, 60]
    assert req.context.ten_ks is None


def test_job_status_response_minimal():
    resp = JobStatusResponse(job_id="j1", status="queued")
    assert resp.output is None
    assert resp.error is None
