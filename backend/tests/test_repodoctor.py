"""Backend tests for RepoDoctor API"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')


class TestHealth:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        print(f"Health: {data}")


class TestStats:
    def test_stats(self):
        r = requests.get(f"{BASE_URL}/api/stats")
        assert r.status_code == 200
        data = r.json()
        assert "total_analyses" in data
        assert "bugs_found" in data
        assert "fixes_applied" in data
        assert "prs_created" in data
        print(f"Stats: {data}")


class TestAnalyses:
    def test_list_analyses(self):
        r = requests.get(f"{BASE_URL}/api/analyses")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        print(f"Analyses count: {len(data)}")

    def test_get_known_analysis(self):
        analysis_id = "565ba6c6-7898-42a6-8d12-e38ce370e31b"
        r = requests.get(f"{BASE_URL}/api/analyses/{analysis_id}")
        assert r.status_code == 200
        data = r.json()
        assert "id" in data
        assert "status" in data
        assert "agent_steps" in data or "bugs" in data
        print(f"Analysis status: {data.get('status')}, bugs: {len(data.get('bugs', []))}")

    def test_create_analysis(self):
        r = requests.post(f"{BASE_URL}/api/analyses", json={"repo_url": "https://github.com/mgedmin/check-python-versions"})
        assert r.status_code == 200
        data = r.json()
        assert "id" in data
        assert data["status"] == "queued"
        analysis_id = data["id"]
        print(f"Created analysis: {analysis_id}")

        # Verify it appears in list
        r2 = requests.get(f"{BASE_URL}/api/analyses/{analysis_id}")
        assert r2.status_code == 200
        return analysis_id

    def test_get_nonexistent_analysis(self):
        r = requests.get(f"{BASE_URL}/api/analyses/nonexistent-id-12345")
        assert r.status_code == 404


class TestSettings:
    def test_get_settings(self):
        r = requests.get(f"{BASE_URL}/api/settings")
        assert r.status_code == 200
        data = r.json()
        print(f"Settings: {list(data.keys())}")

    def test_save_settings(self):
        r = requests.post(f"{BASE_URL}/api/settings", json={
            "github_token": "",
            "telegram_bot_token": "",
            "telegram_chat_id": ""
        })
        assert r.status_code == 200
        data = r.json()
        assert "message" in data
