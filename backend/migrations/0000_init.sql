CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."comparator" AS ENUM('gt', 'gte', 'lt', 'lte');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('pending', 'firing', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('firing', 'severity_increase', 'reminder', 'escalation', 'recovery', 'test');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sending', 'retrying', 'accepted', 'sent', 'delivered', 'read', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rule_kind" AS ENUM('threshold', 'check_failures', 'heartbeat');--> statement-breakpoint
CREATE TYPE "public"."sample_status" AS ENUM('ok', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('viewer', 'operator', 'admin');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"kind" "rule_kind" NOT NULL,
	"metric" text,
	"host_id" uuid,
	"resource" text,
	"comparator" "comparator" DEFAULT 'gt' NOT NULL,
	"warning_threshold" double precision,
	"critical_threshold" double precision,
	"warning_for_seconds" integer DEFAULT 0 NOT NULL,
	"critical_for_seconds" integer DEFAULT 0 NOT NULL,
	"window_samples" integer DEFAULT 10 NOT NULL,
	"cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"reminder_interval_seconds" integer DEFAULT 1800,
	"escalation_after_seconds" integer,
	"escalation_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_warning" boolean DEFAULT true NOT NULL,
	"notify_on_recovery" boolean DEFAULT true NOT NULL,
	"suggested_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_name_unique" UNIQUE("name"),
	CONSTRAINT "alert_rules_threshold_ck" CHECK ("alert_rules"."warning_threshold" IS NOT NULL OR "alert_rules"."critical_threshold" IS NOT NULL),
	CONSTRAINT "alert_rules_durations_ck" CHECK ("alert_rules"."warning_for_seconds" >= 0 AND "alert_rules"."critical_for_seconds" >= 0 AND "alert_rules"."cooldown_seconds" >= 0 AND "alert_rules"."window_samples" >= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "incident_status" NOT NULL,
	"severity" "severity" NOT NULL,
	"summary" text NOT NULL,
	"value" double precision,
	"threshold" double precision,
	"started_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notification_count" integer DEFAULT 0 NOT NULL,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_resolved_ck" CHECK (("incidents"."status" = 'resolved') = ("incidents"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"status" "sample_status" NOT NULL,
	"value" double precision,
	"error" text,
	"collected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "metric_samples_value_status_ck" CHECK (("metric_samples"."status" = 'ok' AND "metric_samples"."value" IS NOT NULL) OR ("metric_samples"."status" = 'unavailable' AND "metric_samples"."value" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"snapshot_key" uuid NOT NULL,
	"agent_version" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitored_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"description" text,
	"environment" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_metrics_at" timestamp with time zone,
	"last_agent_version" text,
	"last_hostname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitored_hosts_name_unique" UNIQUE("name"),
	CONSTRAINT "monitored_hosts_name_ck" CHECK ("monitored_hosts"."name" ~ '^[a-z0-9][a-z0-9._-]{0,62}$')
);
--> statement-breakpoint
CREATE TABLE "notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"http_status" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"provider_message_id" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"recipient" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"accepted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"instance_id" text NOT NULL,
	"version" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase_ck" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_host_id_monitored_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitored_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_host_id_monitored_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitored_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_host_id_monitored_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitored_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_snapshot_id_metric_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."metric_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_host_id_monitored_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitored_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_host_id_monitored_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitored_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_host_name_uq" ON "agents" USING btree ("host_id","name");--> statement-breakpoint
CREATE INDEX "agents_host_idx" ON "agents" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_active_uq" ON "incidents" USING btree ("rule_id","host_id","resource") WHERE "incidents"."status" IN ('pending', 'firing', 'acknowledged');--> statement-breakpoint
CREATE INDEX "incidents_status_started_idx" ON "incidents" USING btree ("status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_host_started_idx" ON "incidents" USING btree ("host_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_started_idx" ON "incidents" USING btree ("started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_fingerprint_idx" ON "incidents" USING btree ("fingerprint","last_notified_at");--> statement-breakpoint
CREATE INDEX "metric_samples_series_idx" ON "metric_samples" USING btree ("host_id","metric","resource","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metric_samples_collected_idx" ON "metric_samples" USING btree ("collected_at");--> statement-breakpoint
CREATE INDEX "metric_samples_snapshot_idx" ON "metric_samples" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_snapshots_agent_key_uq" ON "metric_snapshots" USING btree ("agent_id","snapshot_key");--> statement-breakpoint
CREATE INDEX "metric_snapshots_host_time_idx" ON "metric_snapshots" USING btree ("host_id","collected_at");--> statement-breakpoint
CREATE INDEX "metric_snapshots_collected_idx" ON "metric_snapshots" USING btree ("collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempts_uq" ON "notification_attempts" USING btree ("notification_id","attempt_number");--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" IN ('queued', 'retrying', 'sending');--> statement-breakpoint
CREATE INDEX "notifications_incident_idx" ON "notifications" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "service_heartbeats_uq" ON "service_heartbeats" USING btree ("service","instance_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));