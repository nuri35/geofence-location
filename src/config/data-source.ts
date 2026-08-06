import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';

config();

export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  username: process.env.POSTGRES_USER ?? 'geofence',
  password: process.env.POSTGRES_PASSWORD ?? 'geofence',
  database: process.env.POSTGRES_DB ?? 'geofence',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
});
