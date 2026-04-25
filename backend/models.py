from pydantic import BaseModel, Field
from typing import Annotated, Any, List, Optional
from bson import ObjectId
from datetime import datetime, timezone
import uuid


def utc_now():
    return datetime.now(timezone.utc).isoformat()


PyObjectId = Annotated[str, Field(default_factory=lambda: str(ObjectId()))]


class LogEntry(BaseModel):
    timestamp: str = Field(default_factory=utc_now)
    level: str = "info"
    message: str


class AgentStep(BaseModel):
    step: str
    label: str
    status: str = "pending"  # pending|active|completed|failed|skipped
    message: str = ""
    updated_at: Optional[str] = None


class Bug(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: str  # failing_test|lint|logical
    file: str = ""
    line: Optional[int] = None
    description: str
    stacktrace: str = ""
    severity: str = "medium"


class Fix(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    bug_id: str
    file: str = ""
    original_code: str = ""
    fixed_code: str = ""
    diff: str = ""
    explanation: str = ""
    verified: bool = False


class FileMap(BaseModel):
    language: str = "unknown"
    total_files: int = 0
    test_files: List[str] = []
    entry_points: List[str] = []
    has_requirements: bool = False
    has_package_json: bool = False
    has_pytest: bool = False
    has_jest: bool = False


class Analysis(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    repo_url: str
    repo_name: str = ""
    status: str = "queued"  # queued|cloning|analyzing|fixing|verifying|creating_pr|completed|failed
    agent_steps: List[AgentStep] = Field(default_factory=lambda: [
        AgentStep(step="observe", label="Observe", status="pending"),
        AgentStep(step="decide", label="Decide", status="pending"),
        AgentStep(step="act", label="Act", status="pending"),
        AgentStep(step="verify", label="Verify", status="pending"),
        AgentStep(step="create_pr", label="Create PR", status="pending"),
    ])
    bugs: List[Bug] = []
    fixes: List[Fix] = []
    logs: List[LogEntry] = []
    file_map: Optional[dict] = None
    pr_url: Optional[str] = None
    pr_branch: Optional[str] = None
    error: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    created_at: str = Field(default_factory=utc_now)
    completed_at: Optional[str] = None


class AnalysisCreate(BaseModel):
    repo_url: str
    telegram_chat_id: Optional[str] = None


class Settings(BaseModel):
    id: str = "global"
    github_token: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    updated_at: str = Field(default_factory=utc_now)
