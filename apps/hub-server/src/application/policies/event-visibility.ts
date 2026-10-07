import type { EventEnvelope } from "@agents-hub/shared";

/**
 * Determines if an event envelope should be visible to a specific agent in the project.
 *
 * Rules:
 * - Broadcast events (agent.joined, agent.left, agent.heartbeat, project.created, status.updated, lock.acquired, lock.released): visible to everyone in the project.
 * - Message events (message.created):
 *   - If recipient_agent_ids is empty: broadcast (visible to everyone).
 *   - If recipient_agent_ids has agents: visible ONLY if requestingAgentId is sender OR in recipient_agent_ids.
 *   - If requestingAgentId is undefined (e.g. human dashboard observer), it is visible to project members.
 */
export function isEventVisibleToAgent(event: EventEnvelope, requestingAgentId?: string): boolean {
  if (!requestingAgentId) {
    return true; // Visible to human dashboard observer of the project
  }

  if (event.type === "message.created") {
    const payload = event.payload as {
      sender_id?: string;
      recipient_agent_ids?: string[];
    };

    const senderId = payload.sender_id ?? event.actor_id;
    const recipients = payload.recipient_agent_ids ?? [];

    if (recipients.length === 0) {
      return true; // Public broadcast message in the channel
    }

    return senderId === requestingAgentId || recipients.includes(requestingAgentId);
  }

  return true;
}
