import { Card, CardTitle, Grid, Page, PageHeader, Stack } from '@d3cloud/ui';

/**
 * The console's landing screen. Phase 1 replaces this with the portfolio — the real "where are we"
 * — so this deliberately shows only what Phase 0 can honestly claim.
 */
export function Home({ displayName }: { displayName: string }) {
  return (
    <Page>
      <PageHeader
        title="Foreman"
        description={`Signed in as ${displayName}. The portfolio lands in Phase 1.`}
      />
      <Grid>
        <Card>
          <CardTitle>Plan versus reality</CardTitle>
          <Stack gap="8">
            <p>
              Requirements, phases, tasks, ADRs and audit findings as records rather than prose — with
              the console and the MCP server as equal ways in.
            </p>
          </Stack>
        </Card>
      </Grid>
    </Page>
  );
}
