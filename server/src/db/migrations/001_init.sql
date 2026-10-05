CREATE TYPE deployment_status AS ENUM (
  'QUEUED', 'BUILDING', 'DEPLOYING', 'ACTIVE', 'FAILED', 'CANCELLED', 'REMOVED'
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  -- target of the composite foreign key on deployments
  UNIQUE (project_id, id)
);

CREATE TABLE services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  repo        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  UNIQUE (project_id, id)
);

CREATE TABLE deployment_status_transitions (
  from_status deployment_status NOT NULL,
  to_status   deployment_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO deployment_status_transitions (from_status, to_status) VALUES
  ('QUEUED', 'BUILDING'), ('QUEUED', 'DEPLOYING'), ('QUEUED', 'FAILED'), ('QUEUED', 'CANCELLED'),
  ('BUILDING', 'DEPLOYING'), ('BUILDING', 'FAILED'), ('BUILDING', 'CANCELLED'),
  ('DEPLOYING', 'ACTIVE'), ('DEPLOYING', 'FAILED'), ('DEPLOYING', 'CANCELLED'),
  ('ACTIVE', 'REMOVED');

CREATE TABLE deployments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL,
  service_id          uuid NOT NULL,
  environment_id      uuid NOT NULL,
  status              deployment_status NOT NULL DEFAULT 'QUEUED',
  commit_sha          text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{7,40}$'),
  commit_message      text NOT NULL DEFAULT '',
  image               text,
  rollback_of         uuid REFERENCES deployments (id),
  failure_reason      text,
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  -- a deployment's service and environment must belong to the same project
  FOREIGN KEY (project_id, service_id) REFERENCES services (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, environment_id) REFERENCES environments (project_id, id) ON DELETE CASCADE,
  CHECK (rollback_of IS NULL OR rollback_of <> id),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL)),
  CHECK ((status IN ('FAILED', 'CANCELLED', 'REMOVED')) = (finished_at IS NOT NULL)),
  -- nothing goes live without an image
  CHECK (status NOT IN ('ACTIVE', 'REMOVED') OR image IS NOT NULL),
  -- a rollback reuses its target's image, so it must know it from the start
  CHECK (rollback_of IS NULL OR image IS NOT NULL)
);

-- At most one deployment serves traffic per service and environment.
CREATE UNIQUE INDEX deployments_one_active
  ON deployments (service_id, environment_id) WHERE status = 'ACTIVE';

CREATE INDEX deployments_by_service_env
  ON deployments (service_id, environment_id, created_at DESC);

CREATE TABLE deployment_events (
  id            bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  from_status   deployment_status,
  to_status     deployment_status NOT NULL,
  at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX deployment_events_by_deployment ON deployment_events (deployment_id, id);

CREATE FUNCTION deployments_guard_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' THEN
      RAISE EXCEPTION 'deployments must start QUEUED, got %', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'deployment_status_transition';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM deployment_status_transitions
      WHERE from_status = OLD.status AND to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'deployment % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'deployment_status_transition';
    END IF;
    IF NEW.status IN ('FAILED', 'CANCELLED', 'REMOVED') THEN
      NEW.finished_at := now();
    END IF;
  END IF;

  IF NEW.service_id <> OLD.service_id OR NEW.environment_id <> OLD.environment_id
     OR NEW.commit_sha <> OLD.commit_sha OR NEW.rollback_of IS DISTINCT FROM OLD.rollback_of THEN
    RAISE EXCEPTION 'deployment % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER deployments_guard_status
  BEFORE INSERT OR UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION deployments_guard_status();

CREATE FUNCTION deployments_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO deployment_events (deployment_id, from_status, to_status)
      VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status);
    END IF;
    -- delivered on commit, so listeners never see a change that was rolled back
    PERFORM pg_notify('deployment_changed', json_build_object(
      'id', NEW.id, 'projectId', NEW.project_id, 'serviceId', NEW.service_id,
      'environmentId', NEW.environment_id, 'status', NEW.status
    )::text);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER deployments_record_change
  AFTER INSERT OR UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION deployments_record_change();
