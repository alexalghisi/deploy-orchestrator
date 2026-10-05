import type { Environment, Project, Service } from '../domain/types.js';
import type { Pool } from './pool.js';
import {
  toEnvironment,
  toProject,
  toService,
  type EnvironmentRow,
  type ProjectRow,
  type ServiceRow,
} from './rows.js';

/** Projects, services and environments: the slow-moving part of the model. */
export class PgCatalogRepository {
  constructor(private readonly pool: Pool) {}

  async projects(): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects ORDER BY name');
    return rows.map(toProject);
  }

  async projectsById(ids: readonly string[]): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toProject);
  }

  async servicesById(ids: readonly string[]): Promise<Service[]> {
    const { rows } = await this.pool.query<ServiceRow>('SELECT * FROM services WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toService);
  }

  async environmentsById(ids: readonly string[]): Promise<Environment[]> {
    const { rows } = await this.pool.query<EnvironmentRow>('SELECT * FROM environments WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(toEnvironment);
  }

  async servicesByProject(projectIds: readonly string[]): Promise<Service[]> {
    const { rows } = await this.pool.query<ServiceRow>(
      'SELECT * FROM services WHERE project_id = ANY($1::uuid[]) ORDER BY name',
      [projectIds],
    );
    return rows.map(toService);
  }

  async environmentsByProject(projectIds: readonly string[]): Promise<Environment[]> {
    const { rows } = await this.pool.query<EnvironmentRow>(
      `SELECT * FROM environments WHERE project_id = ANY($1::uuid[])
        ORDER BY CASE name WHEN 'production' THEN 0 ELSE 1 END, name`,
      [projectIds],
    );
    return rows.map(toEnvironment);
  }

  async createProject(name: string, environments: readonly string[]): Promise<Project> {
    const { rows } = await this.pool.query<ProjectRow>('INSERT INTO projects (name) VALUES ($1) RETURNING *', [name]);
    const project = toProject(rows[0]!);
    for (const env of environments) {
      await this.pool.query('INSERT INTO environments (project_id, name) VALUES ($1, $2)', [project.id, env]);
    }
    return project;
  }

  async createService(projectId: string, name: string, repo: string): Promise<Service> {
    const { rows } = await this.pool.query<ServiceRow>(
      'INSERT INTO services (project_id, name, repo) VALUES ($1, $2, $3) RETURNING *',
      [projectId, name, repo],
    );
    return toService(rows[0]!);
  }
}
