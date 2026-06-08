import {
  defineSyncServerPlugin,
  json,
  route,
} from '@actual-app/plugins-core-sync-server/plugin';

import './manifest';

type CalculationBody = {
  operation?: 'add' | 'subtract' | 'multiply' | 'divide';
  a?: unknown;
  b?: unknown;
};

export const plugin = defineSyncServerPlugin({
  routes: [
    route('GET', '/hello', async () =>
      json({
        message: 'Hello from example plugin!',
        timestamp: new Date().toISOString(),
      }),
    ),

    route('GET', '/info', async () =>
      json({
        name: 'example-plugin',
        version: '0.0.1',
        description: 'An example plugin for Actual sync-server',
      }),
    ),

    route('GET', '/status', async () =>
      json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      }),
    ),

    route('POST', '/echo', async request =>
      json({
        received: await request.json(),
        headers: request.headers,
        query: request.query,
      }),
    ),

    route('GET', '/data/:id', async request =>
      json({
        id: request.params.id,
        data: {
          message: `Data for ID: ${request.params.id}`,
          timestamp: new Date().toISOString(),
        },
      }),
    ),

    route('POST', '/calculate', async request => {
      const { operation, a, b } = await request.json<CalculationBody>();

      if (typeof a !== 'number' || typeof b !== 'number') {
        return json(
          {
            error: 'invalid_input',
            message: 'Both a and b must be numbers',
          },
          { status: 400 },
        );
      }

      switch (operation) {
        case 'add':
          return json({ operation, a, b, result: a + b });
        case 'subtract':
          return json({ operation, a, b, result: a - b });
        case 'multiply':
          return json({ operation, a, b, result: a * b });
        case 'divide':
          if (b === 0) {
            return json(
              {
                error: 'division_by_zero',
                message: 'Cannot divide by zero',
              },
              { status: 400 },
            );
          }
          return json({ operation, a, b, result: a / b });
        default:
          return json(
            {
              error: 'invalid_operation',
              message:
                'Operation must be one of: add, subtract, multiply, divide',
            },
            { status: 400 },
          );
      }
    }),

    route('GET', '/admin/settings', async () =>
      json({
        message: 'Admin settings accessed',
        settings: {
          pluginEnabled: true,
          maxRequests: 1000,
          logLevel: 'info',
        },
      }),
    ),

    route('POST', '/admin/settings', async request =>
      json({
        message: 'Settings updated successfully',
        updates: await request.json(),
        timestamp: new Date().toISOString(),
      }),
    ),
  ],
});
