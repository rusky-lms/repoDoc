import pytest
import os
import sys
import uuid
import time
import asyncio
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

# Ensure backend directory is in path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import app, check_ask_rate_limit, _user_ask_history
from auth import create_access_token
from models import Bug, Fix, Analysis
from agent import generate_gemini_summary
from github_service import GitHubService


@pytest.fixture
def test_client():
    return TestClient(app)


@pytest.fixture
def auth_headers():
    token = create_access_token(data={"sub": "testuser"})
    return {"Authorization": f"Bearer {token}"}


class TestTelegramRemoval:
    """Tests confirming Telegram integration and UI/settings have been completely removed."""

    def test_health_endpoint_has_no_telegram(self, test_client):
        response = test_client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "telegram" not in data, "Telegram should not be present in health response"
        assert "github" in data

    @patch("server.db")
    def test_settings_has_no_telegram_fields(self, mock_db, test_client, auth_headers):
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})
        mock_db.settings.find_one = AsyncMock(return_value={
            "id": "global",
            "user_id": "user-123",
            "github_token": "ghp_1234567890abcdef",
            "telegram_bot_token": "should_be_stripped",
            "telegram_chat_id": "should_be_stripped",
        })

        response = test_client.get("/api/settings", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert "telegram_bot_token" not in data
        assert "telegram_chat_id" not in data
        assert "telegram_bot_token_masked" not in data
        assert "github_token_masked" in data

    @patch("server.db")
    def test_save_settings_strips_telegram(self, mock_db, test_client, auth_headers):
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})
        mock_db.settings.find_one = AsyncMock(return_value={"id": "s1", "user_id": "user-123"})
        mock_db.settings.replace_one = AsyncMock(return_value=None)

        payload = {
            "github_token": "ghp_testtoken",
            "telegram_bot_token": "test_bot_token",
            "telegram_chat_id": "12345",
        }
        response = test_client.post("/api/settings", json=payload, headers=auth_headers)
        assert response.status_code == 200

        saved_doc = mock_db.settings.replace_one.call_args[0][1]
        assert "telegram_bot_token" not in saved_doc
        assert "telegram_chat_id" not in saved_doc


class TestLLMSummaries:
    """Tests for LLM summary generation and fallback behavior."""

    def test_generate_summary_fallback_on_failure(self):
        """If the Gemini call fails, fall back to the plain list of findings and never fail the analysis."""
        bugs = [
            {"id": "b1", "file": "main.py", "line": 10, "type": "lint", "severity": "warning", "description": "Unused import sys"},
            {"id": "b2", "file": "calc.py", "line": 25, "type": "test_failure", "severity": "high", "description": "ZeroDivisionError in divide()"}
        ]
        fixes = [
            {"id": "f1", "bug_id": "b1", "file": "main.py", "diff": "--- main.py\n+++ main.py\n-import sys", "explanation": "Remove unused import"}
        ]

        # Call with invalid/failing key to trigger exception
        with patch("agent.LlmChat.send_message", side_effect=Exception("Gemini quota exceeded")):
            summary, updated_fixes = asyncio.run(generate_gemini_summary(
                repo_name="org/test-repo",
                bugs=bugs,
                fixes=fixes,
                llm_key="fake-key"
            ))

            # Never fails, returns fallback
            assert "Unused import sys" in summary
            assert "ZeroDivisionError in divide()" in summary
            assert updated_fixes[0]["why_this_change"] == "Remove unused import"

    def test_generate_summary_empty_bugs(self):
        bugs = []
        fixes = []
        summary, updated_fixes = asyncio.run(generate_gemini_summary("org/clean-repo", bugs, fixes, "key"))
        assert "No issues" in summary or "clean" in summary.lower()

    def test_generate_summary_success(self):
        bugs = [{"id": "b1", "file": "app.py", "line": 5, "type": "bug", "severity": "high", "description": "Null pointer"}]
        fixes = [{"id": "f1", "bug_id": "b1", "file": "app.py", "diff": "+ if x is not None:", "explanation": ""}]

        mock_gemini_reply = '{"summary": "Detected critical null check issue in app.py.", "fixes": [{"file": "app.py", "why_this_change": "Adds explicit guard clause against NoneType."}]}'

        with patch("agent.LlmChat.send_message", AsyncMock(return_value=mock_gemini_reply)):
            summary, updated_fixes = asyncio.run(generate_gemini_summary("org/test-repo", bugs, fixes, "valid-key"))
            assert "critical null check" in summary
            assert updated_fixes[0]["why_this_change"] == "Adds explicit guard clause against NoneType."
            assert updated_fixes[0]["explanation"] == "Adds explicit guard clause against NoneType."

    def test_github_pr_body_includes_summary_and_why(self):
        gh = GitHubService(token="ghp_test")
        fixes = [{
            "file": "utils.py",
            "verified": True,
            "why_this_change": "Prevent division by zero when divisor is zero",
            "explanation": "division check"
        }]

        # Verify PR body format contains both summary and why this change
        short_id = "12345678"
        summary = "Refactored math routines to prevent unhandled zero division crashes."

        summary_section = f"### Summary of Issues Found\n{summary}\n\n"
        fix_lines = f"- **utils.py**: {fixes[0]['why_this_change']}"

        assert "Refactored math routines" in summary_section
        assert "Prevent division by zero" in fix_lines


class TestFollowUpQA:
    """Tests for Follow-up Q&A endpoint: auth, rate limiting, and Gemini grounding."""

    def test_ask_requires_auth(self, test_client):
        # 401 without auth header
        res = test_client.post("/api/analyses/analysis-123/ask", json={"question": "What changed?"})
        assert res.status_code == 401

    @patch("server.db")
    def test_ask_nonexistent_analysis_returns_404(self, mock_db, test_client, auth_headers):
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})
        mock_db.analyses.find_one = AsyncMock(return_value=None)

        res = test_client.post("/api/analyses/nonexistent/ask", json={"question": "What was fixed?"}, headers=auth_headers)
        assert res.status_code == 404
        assert "not found" in res.json()["detail"].lower()

    @patch("server.db")
    def test_ask_empty_question_returns_400(self, mock_db, test_client, auth_headers):
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})

        res = test_client.post("/api/analyses/analysis-123/ask", json={"question": "   "}, headers=auth_headers)
        assert res.status_code == 400

    @patch("server.db")
    def test_ask_rate_limit_exceeded(self, mock_db, test_client, auth_headers):
        mock_db.users.find_one = AsyncMock(return_value={"id": "rate-limit-user", "username": "testuser"})
        mock_db.analyses.find_one = AsyncMock(return_value={
            "id": "analysis-1",
            "user_id": "rate-limit-user",
            "bugs": [],
            "fixes": [],
            "summary": "clean"
        })

        # Pre-fill 10 recent timestamps for this user to trigger 429
        _user_ask_history["rate-limit-user"] = [time.time()] * 10

        res = test_client.post("/api/analyses/analysis-1/ask", json={"question": "Hello?"}, headers=auth_headers)
        assert res.status_code == 429
        assert "rate limit exceeded" in res.json()["detail"].lower()

    @patch("server.db")
    def test_ask_successful_grounded_answer(self, mock_db, test_client, auth_headers):
        _user_ask_history.pop("user-123", None)
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})
        mock_db.analyses.find_one = AsyncMock(return_value={
            "id": "analysis-42",
            "user_id": "user-123",
            "repo_name": "acme/api",
            "summary": "Fixed security vulnerability in SQL query parser.",
            "bugs": [
                {"id": "bug-1", "file": "query.py", "line": 42, "type": "security", "severity": "critical", "description": "SQL injection via raw formatting"}
            ],
            "fixes": [
                {
                    "file": "query.py",
                    "verified": True,
                    "why_this_change": "Parameterized the query using cursor placeholders instead of f-strings.",
                    "diff": "--- query.py\n+++ query.py\n-cursor.execute(f'SELECT * FROM users WHERE id = {user_id}')\n+cursor.execute('SELECT * FROM users WHERE id = %s', (user_id,))"
                }
            ]
        })

        mock_answer = "Line 42 in query.py was changed from raw string interpolation to parameterized SQL parameters to eliminate the SQL injection defect."

        with patch("server.get_llm_key", return_value="test-llm-key"):
            with patch("server.LlmChat.send_message", AsyncMock(return_value=mock_answer)):
                res = test_client.post(
                    "/api/analyses/analysis-42/ask",
                    json={"question": "Why did you change line 42 in query.py?", "history": []},
                    headers=auth_headers
                )
                assert res.status_code == 200
                data = res.json()
                assert data["analysis_id"] == "analysis-42"
                assert "parameterized SQL parameters" in data["answer"]

    @patch("server.db")
    def test_ask_root_endpoint_compatibility(self, mock_db, test_client, auth_headers):
        _user_ask_history.pop("user-123", None)
        mock_db.users.find_one = AsyncMock(return_value={"id": "user-123", "username": "testuser"})
        mock_db.analyses.find_one = AsyncMock(return_value={
            "id": "analysis-root",
            "user_id": "user-123",
            "bugs": [],
            "fixes": [],
            "summary": "Everything is good."
        })

        with patch("server.get_llm_key", return_value="test-llm-key"):
            with patch("server.LlmChat.send_message", AsyncMock(return_value="No changes were necessary.")):
                res = test_client.post(
                    "/analyses/analysis-root/ask",
                    json={"question": "Were any changes made?"},
                    headers=auth_headers
                )
                assert res.status_code == 200
                assert res.json()["answer"] == "No changes were necessary."


class TestAgentLoopUI:
    """Tests verifying the agent loop step updates work correctly with DB persistence."""

    def test_db_apply_set_positional_and_direct(self):
        from db import _apply_set

        doc = {
            "id": "test-123",
            "agent_steps": [
                {"step": "observe", "status": "pending", "message": ""},
                {"step": "decide", "status": "pending", "message": ""},
                {"step": "act", "status": "pending", "message": ""},
            ]
        }

        # Test positional update
        _apply_set(
            doc,
            {"agent_steps.$.status": "active", "agent_steps.$.message": "Running..."},
            {"id": "test-123", "agent_steps.step": "decide"}
        )

        assert doc["agent_steps"][1]["status"] == "active"
        assert doc["agent_steps"][1]["message"] == "Running..."
        assert doc["agent_steps"][0]["status"] == "pending"

        # Test full array update
        updated_steps = [
            {"step": "observe", "status": "completed", "message": "done"},
            {"step": "decide", "status": "completed", "message": "done"},
            {"step": "act", "status": "completed", "message": "done"},
        ]
        _apply_set(doc, {"agent_steps": updated_steps}, {"id": "test-123"})
        assert doc["agent_steps"][0]["status"] == "completed"
        assert doc["agent_steps"][2]["status"] == "completed"

    def test_run_analysis_agent_steps_progression(self):
        from agent import run_analysis_task

        fake_analysis = {
            "id": "analysis-prog-1",
            "repo_url": "https://github.com/test/repo",
            "agent_steps": [
                {"step": "observe", "label": "Observe", "status": "pending"},
                {"step": "decide", "label": "Decide", "status": "pending"},
                {"step": "act", "label": "Act", "status": "pending"},
                {"step": "verify", "label": "Verify", "status": "pending"},
                {"step": "create_pr", "label": "Create PR", "status": "pending"},
            ],
            "status": "queued",
            "logs": [],
            "bugs": [],
            "fixes": []
        }

        class MockAnalyses:
            def __init__(self, doc):
                self.doc = doc

            async def find_one(self, query, projection=None):
                return self.doc

            async def update_one(self, query, update, upsert=False):
                if "$set" in update:
                    self.doc.update(update["$set"])
                if "$push" in update:
                    for k, v in update["$push"].items():
                        self.doc.setdefault(k, []).append(v)
                return True

        class MockDb:
            def __init__(self, doc):
                self.analyses = MockAnalyses(doc)

        mock_db = MockDb(fake_analysis)

        with patch("agent.run_cmd", AsyncMock(return_value=(0, "test", ""))):
            with patch("agent.build_file_map", return_value={"total_files": 10, "language": "python", "has_requirements": False}):
                with patch("agent.decide_strategy", return_value={"language": "python", "test_cmd": None, "lint_cmd": None}):
                    asyncio.run(run_analysis_task(
                        analysis_id="analysis-prog-1",
                        repo_url="https://github.com/test/repo",
                        db=mock_db,
                        llm_key="fake-key"
                    ))

        # Check that steps were properly transitioned from 'pending'
        steps_by_name = {s["step"]: s for s in fake_analysis["agent_steps"]}
        assert steps_by_name["observe"]["status"] == "completed"
        assert steps_by_name["decide"]["status"] == "completed"
        assert steps_by_name["act"]["status"] == "completed"
        assert steps_by_name["verify"]["status"] == "skipped"  # skipped because 0 bugs
        assert steps_by_name["create_pr"]["status"] == "skipped"
        assert fake_analysis["status"] == "completed"

