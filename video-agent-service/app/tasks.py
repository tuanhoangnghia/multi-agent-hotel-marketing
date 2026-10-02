from google.cloud import tasks_v2

from .config import get_settings


def enqueue_process_job(job_id: str) -> None:
    settings = get_settings()
    client = tasks_v2.CloudTasksClient()
    parent = client.queue_path(settings.gcp_project_id, settings.cloud_tasks_location, settings.cloud_tasks_queue)
    url = f"{settings.process_job_base_url.rstrip('/')}/internal/process-job/{job_id}"
    http_request: dict = {
        "http_method": tasks_v2.HttpMethod.POST,
        "url": url,
        "headers": {"X-Internal-Task-Token": settings.internal_task_token},
    }
    client.create_task(parent=parent, task={"http_request": http_request})
