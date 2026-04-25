import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";
import NavBar from "@/components/NavBar";
import Dashboard from "@/pages/Dashboard";
import AnalysisDetail from "@/pages/AnalysisDetail";
import History from "@/pages/History";
import Settings from "@/pages/Settings";

function App() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white">
      <BrowserRouter>
        <NavBar />
        <main className="pt-14">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/analysis/:id" element={<AnalysisDetail />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </div>
  );
}

export default App;
