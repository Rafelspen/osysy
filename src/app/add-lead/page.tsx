export const dynamic = "force-dynamic";

export default function AddLeadPage({ searchParams }: { searchParams: { added?: string; error?: string } }) {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Add Lead</h1>
      <p className="text-sm text-slate-600">
        Adds a new row to the Sheet with the website URL and stage <code>SOURCED</code>. The pipeline picks it up on
        the next tick.
      </p>

      {searchParams.error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}
      {searchParams.added && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Lead added.
        </div>
      )}

      <form action="/api/leads/add" method="POST" className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Website URL</label>
          <input
            type="url"
            name="website_url"
            required
            placeholder="https://example.com"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Source <span className="font-normal text-slate-400">(optional — platform/profile URL; defaults to website URL)</span>
          </label>
          <input
            type="text"
            name="source"
            placeholder="https://linkedin.com/company/..."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Add Lead
        </button>
      </form>
    </div>
  );
}
