import type { CanActivate, ManifestRoute, RequestContext } from '@kivin/core';
import { Injectable } from '@kivin/decorators';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: RequestContext, route: ManifestRoute) {
    if (route.method !== 'POST') {
      return true;
    }

    return context.request.headers.get('x-api-key') === 'secret';
  }
}
