"use client";

import { useState } from "react";

export default function DisconnectGmailButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect Gmail? The pipeline pauses until you connect an account again. Your leads, Sheet link and templates are kept."
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/google/disconnect", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message ?? `Request failed (${res.status})`);
      window.location.href = "/connect?disconnected=gmail";
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={disconnect}
        disabled={busy}
        className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? "Disconnecting..." : "Disconnect Gmail"}
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </>
  );
}
