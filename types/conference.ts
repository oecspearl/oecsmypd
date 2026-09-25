export interface VideoConference {
  id: string;
  title: string;
  description?: string;
  course_id: string;
  lesson_id?: string;
  instructor_id: string;
  meeting_id: string;
  meeting_url: string;
  meeting_password?: string;
  video_provider?: '8x8vc' | 'google_meet' | 'bigbluebutton' | 'zoom';
  google_meet_link?: string;
  /**
   * Zoom: true when the API redacted meeting_url/meeting_password for this
   * viewer. Students must go through the tracked join flow instead.
   */
  link_redacted?: boolean;
  bbb_attendee_pw?: string;
  bbb_moderator_pw?: string;
  scheduled_at?: string;
  timezone?: string;
  duration_minutes: number;
  max_participants: number;
  recording_enabled: boolean;
  waiting_room_enabled: boolean;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  created_at: string;
  updated_at: string;
  instructor?: any;
  course?: any;
  lesson?: any;
  participants?: ConferenceParticipant[];
}

export interface ConferenceParticipant {
  id: string;
  conference_id: string;
  user_id: string;
  joined_at?: string;
  left_at?: string;
  role: 'host' | 'co-host' | 'participant';
  user?: any;
}

/** One row per join action for external providers (Zoom). */
export interface ConferenceAccessLog {
  id: string;
  conference_id: string;
  user_id: string | null;
  course_id?: string | null;
  event: 'page_view' | 'join_click' | 'join_redirect' | 'leave';
  role?: string | null;
  occurred_at: string;
  last_seen_at?: string | null;
  ended_at?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  device_type?: string | null;
  browser?: string | null;
  os?: string | null;
  referrer?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConferenceRecording {
  id: string;
  conference_id: string;
  recording_url: string;
  recording_duration?: number;
  file_size?: number;
  created_at: string;
}

