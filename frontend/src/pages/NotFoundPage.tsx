import { PageHeader } from "../components/ui";
import { href } from "../lib/router";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        This page does not exist. <a href={href("/")}>Go to the overview</a>.
      </p>
    </>
  );
}
