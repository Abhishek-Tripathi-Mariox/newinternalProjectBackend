import { Router } from 'express';
import { authenticate } from './middleware/authenticate.js';

import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import rolesRoutes from './modules/roles/roles.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import peopleRoutes from './modules/people/people.routes.js';
import mastersRoutes from './modules/masters/masters.routes.js';
import leadsRoutes from './modules/leads/leads.routes.js';
import followUpsRoutes from './modules/followups/followups.routes.js';
import projectIntegrationsRoutes from './modules/project-integrations/integrations.routes.js';
import projectFollowUpsRoutes from './modules/project-followups/projectFollowups.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import documentsRoutes from './modules/documents/documents.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';
import milestonesRoutes from './modules/projects/milestones.routes.js';
import changeRequestsRoutes from './modules/change-requests/changeRequests.routes.js';
import tasksRoutes from './modules/tasks/tasks.routes.js';
import bugsRoutes from './modules/bugs/bugs.routes.js';
import timeLogsRoutes from './modules/timesheets/timesheets.routes.js';
import workdayRoutes from './modules/workday/workday.routes.js';
import liveRoutes from './modules/workday/live.routes.js';
import publicPortalRoutes from './modules/projects/portal.public.routes.js';

/** /api/v1 — public routes first, then everything behind `authenticate`. */
export function apiRouter() {
  const r = Router();

  // Public
  r.use('/auth', authRoutes); // login / refresh / logout are public; /auth/me authenticates itself
  r.use('/public/portal', publicPortalRoutes); // client portal by share token

  // Authenticated
  r.use(authenticate);
  r.use('/users', usersRoutes);
  r.use('/roles', rolesRoutes);
  r.use('/audit-logs', auditRoutes);
  r.use('/', peopleRoutes); // /members, /sales-owners
  r.use('/', mastersRoutes); // /lead-stages, /lead-sources, /services, /settings
  r.use('/leads', leadsRoutes);
  r.use('/follow-ups', followUpsRoutes);
  r.use('/project-follow-ups', projectFollowUpsRoutes);
  r.use('/project-integrations', projectIntegrationsRoutes);
  r.use('/dashboard', dashboardRoutes);
  r.use('/documents', documentsRoutes);
  r.use('/projects', projectsRoutes);
  r.use('/milestones', milestonesRoutes);
  r.use('/change-requests', changeRequestsRoutes);
  r.use('/tasks', tasksRoutes);
  r.use('/bugs', bugsRoutes);
  r.use('/time-logs', timeLogsRoutes);
  r.use('/workday', workdayRoutes); // the signed-in person's own day: check in/out, breaks, timer, end shift
  r.use('/', liveRoutes); // CEO: /live, /attendance, /reports
  return r;
}
