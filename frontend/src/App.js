import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";
import NavBar from "@/components/NavBar";
import Dashboard from "@/pages/Dashboard";
import AnalysisDetail from "@/pages/AnalysisDetail";
import History from "@/pages/History";
import Settings from "@/pages/Settings";
import Guardrails from "@/pages/Guardrails";
import Watch from "@/pages/Watch";
import Login from "@/pages/Login";
import Register from "@/pages/Register";

function ProtectedRoute({ children }) {
  const token = localStorage.getItem("token");
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white">
      <BrowserRouter>
        <NavBar />
        <main className="pt-14">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/analysis/:id" element={<ProtectedRoute><AnalysisDetail /></ProtectedRoute>} />
            <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
            <Route path="/watch" element={<ProtectedRoute><Watch /></ProtectedRoute>} />
            <Route path="/guardrails" element={<ProtectedRoute><Guardrails /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </div>
  );
}

export default App;
