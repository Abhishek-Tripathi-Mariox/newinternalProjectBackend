const iso = (d) => (d ? new Date(d).toISOString() : null);

export const toUserDto = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  title: u.title,
  role: u.role_id,
  roleName: u.role_name,
  dept: u.dept,
  reportsTo: u.reports_to,
  joinDate: u.join_date,
  status: u.status,
  invitedAt: iso(u.invited_at),
  lastActiveAt: iso(u.last_active_at),
  hue: u.hue,
  memberId: u.member_id,
  ownerId: u.owner_id,
  clientOf: u.client_of || [],
  shiftHours: Number(u.shift_hours),
  createdAt: iso(u.created_at),
  updatedAt: iso(u.updated_at),
});
