// A consumer built the way `bun init` configures it (`lib: ["ESNext"]`, no DOM) with `skipLibCheck: false`.
// Any DOM-only global name in a published declaration (FormDataEntryValue, HeadersInit, BodyInit, JsonWebKey, ...)
// surfaces here as an unresolved name instead of silently becoming `any`.
import * as cli from '@kivinjs/cli';
import * as config from '@kivinjs/config';
import * as core from '@kivinjs/core';
import * as decorators from '@kivinjs/decorators';
import * as graphql from '@kivinjs/graphql';
import * as http from '@kivinjs/http';
import * as jwt from '@kivinjs/jwt';
import * as logger from '@kivinjs/logger';
import * as observability from '@kivinjs/observability';
import * as openapi from '@kivinjs/openapi';
import * as schedule from '@kivinjs/schedule';
import * as security from '@kivinjs/security';
import * as session from '@kivinjs/session';
import * as standardSchema from '@kivinjs/standard-schema';
import * as staticFiles from '@kivinjs/static';
import * as valibot from '@kivinjs/valibot';
import { createClient } from '../../examples/basic/.kivin/generated/client';

export const packages = { cli, config, core, decorators, graphql, http, jwt, logger, observability, openapi, schedule, security, session, standardSchema, staticFiles, valibot };
export const client = createClient;
