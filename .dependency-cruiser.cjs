/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "apps-must-not-depend-on-other-apps",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: {
        path: "^apps/[^/]+/",
        pathNot: "^apps/$1/"
      }
    },
    {
      name: "packages-must-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    },
    {
      name: "core-must-not-depend-on-infra",
      severity: "error",
      from: { path: "^packages/(domain|protocol|shared)/" },
      to: {
        path: "(^packages/(db|auth|observability)/)|(@orkiva/(db|auth|observability))"
      }
    },
    {
      name: "domain-must-be-framework-free",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: {
        path: "node_modules/(?:drizzle-orm|pg|pino|@opentelemetry|fastify|express|koa)"
      }
    },
    {
      name: "protocol-must-be-framework-free",
      severity: "error",
      from: { path: "^packages/protocol/" },
      to: {
        path: "node_modules/(?:drizzle-orm|pg|pino|@opentelemetry|fastify|express|koa)"
      }
    }
  ],
  options: {
    includeOnly: {
      path: "^(apps|packages)/"
    },
    tsConfig: {
      fileName: "tsconfig.base.json"
    },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"]
    },
    doNotFollow: {
      path: "node_modules"
    }
  }
};
