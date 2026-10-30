import Reporting from "../Reporting";
import type { WorkspaceProps } from "./types";
export default function ReportingWorkspace({
  token: _token,
  canAccess,
  isAdministrator,
  canBuild,
  ...props
}: WorkspaceProps & {
  canAccess: boolean;
  isAdministrator: boolean;
  canBuild: boolean;
}) {
  return canAccess ? (
    <Reporting
      {...props}
      isAdministrator={isAdministrator}
      canBuild={canBuild}
    />
  ) : (
    <section className="rfq-workspace">
      <div className="rfq-empty-card">
        <h3>No access to Reporting</h3>
        <p>Ask an administrator for the Reporting role.</p>
      </div>
    </section>
  );
}
