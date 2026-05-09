/**
 * Per-adapter cloud-runtime defaults.
 *
 * Each entry tells the driver:
 *   - runtimeImage:  Which `agent-runtime-<adapter>` image to run (default
 *                    fallback is `agent-runtime-base`, which has no adapter
 *                    CLI and only succeeds for adapters whose binary is
 *                    already on PATH via the base image).
 *   - envKeys:       Which keys the driver should materialize from the
 *                    per-Job env Secret into the container's environment.
 *                    The Secret itself is populated by the server (from
 *                    company secrets) before driver.run() is called.
 *   - allowFqdns:    DNS names the tenant's NetworkPolicy + optional Cilium
 *                    CNP must permit egress to. Per-tenant policy overrides
 *                    via cluster_tenant_policies.networkJson.additionalAllowFqdns
 *                    are merged on top in ensureTenantNamespace.
 *
 * The image tags are appended downstream by the server's resolveRunContext;
 * this registry only carries the image NAME (no tag).
 */

export interface AdapterDefaults {
  /** Image name without tag, e.g. "ghcr.io/paperclipai/agent-runtime-claude". */
  runtimeImage: string;
  /** Env keys to copy from the per-Job Secret into the container environment. */
  envKeys: string[];
  /** FQDNs the tenant must be permitted egress to for the adapter to function. */
  allowFqdns: string[];
}

const REGISTRY_BASE = "ghcr.io/paperclipai";

export const ADAPTER_DEFAULTS: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: `${REGISTRY_BASE}/agent-runtime-claude`,
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
  },
};

export function getAdapterDefaults(adapterType: string): AdapterDefaults {
  return (
    ADAPTER_DEFAULTS[adapterType] ?? {
      runtimeImage: `${REGISTRY_BASE}/agent-runtime-base`,
      envKeys: [],
      allowFqdns: [],
    }
  );
}
