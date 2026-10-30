import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { roadmapDocuments, type RoadmapDocument } from "./roadmapDocuments";
import { filterRoadmapTables, roadmapStatuses } from "./roadmapStatus";
export default function RoadmapPage({
  document,
}: {
  document: RoadmapDocument;
}) {
  const [status, setStatus] = useState("all");
  return (
    <section className="roadmap-page">
      <div className="roadmap-filter-bar">
        <label>
          Filter table rows by status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            {roadmapStatuses.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <RoadmapContent markdown={roadmapDocuments[document]} status={status} />
    </section>
  );
}

export function RoadmapContent({
  markdown,
  status = "all",
}: {
  markdown: string;
  status?: string;
}) {
  return (
    <>
      <article className="roadmap-document">
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm, [filterRoadmapTables, { status }]]}
          components={{
            h1: ({ children }) => <h2>{children}</h2>,
            h2: ({ children }) => <h3>{children}</h3>,
            h3: ({ children }) => <h4>{children}</h4>,
            table: ({ children }) => (
              <div className="roadmap-table-wrap">
                <table className="roadmap-table">{children}</table>
              </div>
            ),
          }}
        >
          {markdown}
        </Markdown>
      </article>
    </>
  );
}
