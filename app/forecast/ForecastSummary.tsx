import { forecastSummary } from "./forecastData";

export default function ForecastSummary() {
  return (
    <section className="forecast-summary">

      {forecastSummary.map((item) => (

        <article
          key={item.title}
          className="forecast-card"
        >

          <p className="forecast-title">
            {item.title}
          </p>

          <h2>{item.value}</h2>

          <span className="forecast-status">
            {item.status}
          </span>

        </article>

      ))}

    </section>
  );
} 