import type { ComponentType, ReactNode } from 'react';
import { JiraLogo } from './components/JiraLogo';
import { JiraIntegrationPanel, type PanelProps } from './components/JiraIntegrationPanel';
import type { JiraStatus, Project } from './types';

export interface IntegrationContext {
  project: Project | null;
  status: JiraStatus;
}

export interface Integration {
  id: string;
  name: string;
  icon: ReactNode;
  summary: (ctx: IntegrationContext) => string;
  Panel: ComponentType<PanelProps>;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: 'jira',
    name: 'Jira',
    icon: <JiraLogo size={22} />,
    summary: ({ project, status }) => (status.available ?? status.configured) ? (project?.jiraEnabled ? 'Enabled' : 'Disabled') : 'Unavailable',
    Panel: JiraIntegrationPanel,
  },
];
