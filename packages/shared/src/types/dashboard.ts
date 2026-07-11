export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

/**
 * Company-wide credential/auth outage signal derived from the most recent
 * terminal heartbeat runs. When an adapter's credentials break (missing/invalid
 * token), runs fail back-to-back with an auth error code — an outage signature
 * that is otherwise indistinguishable from inactivity-monitor pollution in the
 * per-day counts. `consecutiveFailures` counts the most-recent terminal runs
 * that failed on an auth error code, uninterrupted by any other outcome, so a
 * systemic auth failure is diagnosable at a glance without per-agent DB queries.
 */
export interface DashboardAuthFailureAlert {
  /** Number of most-recent consecutive terminal runs that failed on an auth error code. */
  consecutiveFailures: number;
  /** Streak length at which `triggered` flips true. */
  threshold: number;
  /** `consecutiveFailures >= threshold`. */
  triggered: boolean;
  /** ISO timestamp of the most recent auth failure in the streak, or null if none. */
  latestFailureAt: string | null;
  /** The most recent auth error code in the streak (e.g. `auth_required`), or null if none. */
  errorCode: string | null;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
  authFailureAlert: DashboardAuthFailureAlert;
}
