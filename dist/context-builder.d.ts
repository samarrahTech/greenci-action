import { ChangedFile, ChangeContext, RouteChange, ComponentChange, APIEndpointChange } from './types';
export declare function buildChangeContext(files: ChangedFile[]): ChangeContext;
export declare function extractRoutes(files: ChangedFile[]): RouteChange[];
export declare function extractComponents(files: ChangedFile[]): ComponentChange[];
export declare function extractAPIEndpoints(files: ChangedFile[]): APIEndpointChange[];
