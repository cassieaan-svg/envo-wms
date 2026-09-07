import { Card, CardBody } from '../../components/ui/Card'

// Placeholder for an administration screen that is routed but not yet built
// (Phase 2M.1 wires the identity and navigation; Phase 2M builds the screens).
//
// It exists so the nav lands somewhere honest instead of the generic
// "Page not found", which would be indistinguishable from a routing bug.
export function StagedSurface({ title, summary }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-medium text-gray-100">{title}</h1>
        <p className="text-sm text-gray-500 mt-1">{summary}</p>
      </div>
      <Card><CardBody>
        <div className="py-8 text-center">
          <div className="text-sm text-gray-400">This screen is not built yet.</div>
          <div className="text-xs text-gray-500 mt-2 max-w-md mx-auto">
            The administrative identity and navigation are in place. The
            configuration screens land in the next step, along with the
            endpoints that enforce the same rules server-side.
          </div>
        </div>
      </CardBody></Card>
    </div>
  )
}

export const UserAccessStaged = () => (
  <StagedSurface
    title="User &amp; Access Management"
    summary="Roles, geographic and section scope, and per-user permission overrides."
  />
)

export const FeatureConfigStaged = () => (
  <StagedSurface
    title="Feature Configuration"
    summary="Switch a workflow off for one department at one facility. Off suppresses; on never grants."
  />
)
