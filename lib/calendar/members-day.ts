// The calendar events that belong on one member's own day: the household's
// (assigned to nobody) and the member's own. Shared by the home dashboard's
// Today and Coming Up and the kids page's Today, so a child's screen and a
// member's home page draw the same line around a parent's or a sibling's
// appointments.
export function onMembersDay(memberId: string) {
  return (event: { assignee_id: string | null }) => event.assignee_id === null || event.assignee_id === memberId;
}
