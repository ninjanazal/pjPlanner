// The Jira mark in Jira blue.
export const JiraLogo = ({ size = 12 }: { size?: number }) => (
  <svg className="jira-logo" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path fill="var(--jira-logo, #2684ff)" d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z" />
  </svg>
);

const icon = (children: React.ReactNode) => (
  <svg className="jira-icon" viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
// Cloud with an arrow going up: send a new issue to Jira.
export const UploadIcon = () => icon(<><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.5 9.5" /><path d="M12 21v-8" /><path d="m9 15.5 3-3 3 3" /></>);
// Arrow up onto a bar: push local edits to the linked issue.
export const PushIcon = () => icon(<><path d="M5 4h14" /><path d="M12 20V8" /><path d="m7 12 5-5 5 5" /></>);
// Circular arrows: pull the current Jira state.
export const RefreshIcon = () => icon(<><path d="M20 11a8 8 0 0 0-14.5-4.2L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.5 4.2L20 15" /><path d="M20 20v-5h-5" /></>);
