import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { McpDialog } from '../components/McpDialog';

describe('McpDialog', () => {
  it('links to the download and shows the command with this origin', () => {
    render(<McpDialog onClose={() => {}} />);
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', '/api/mcp/download');
    expect(screen.getByText(/mkdir -p .*PJPLANNER_URL=http/)).toBeInTheDocument();
    expect(screen.getAllByText(/~\/\.pjplanner/).length).toBeGreaterThan(0);
  });

  it('offers the whole skill suite in one command', () => {
    render(<McpDialog onClose={() => {}} />);
    expect(screen.getByText(/for s in pjplanner-map pjplanner-breakdown.*api\/mcp\/skills\/\$s/)).toBeInTheDocument();
    expect(screen.getByText('/pjplanner-breakdown')).toBeInTheDocument();
  });
});
