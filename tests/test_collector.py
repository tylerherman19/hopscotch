import json
import tempfile
import time
import unittest
from unittest.mock import patch
from google.transit import gtfs_realtime_pb2 as gtfs
import collector as c


class CollectorTests(unittest.TestCase):
    def feeds(self):
        feeds = {name: gtfs.FeedMessage() for name in ('vehicles', 'trips', 'alerts')}
        self.now = int(time.time())
        for f in feeds.values():
            f.header.gtfs_realtime_version = '2.0'
            f.header.timestamp = self.now
        return feeds

    def poll(self, feeds, hop_arrivals=None):
        def feed(name):
            if isinstance(feeds[name], Exception): raise feeds[name]
            return feeds[name]
        def hop(url):
            return hop_arrivals or [] if 'GetRouteStopArrivals' in url else []
        with tempfile.TemporaryDirectory() as folder, patch.object(c, 'LIVE', folder), patch.object(c, 'fetch_feed', side_effect=feed), patch.object(c, 'fetch_json', side_effect=hop), patch.object(c, 'run_alerts'):
            return c.poll_cycle({'trip_index': {}, 'sched_ids': [], 'seen': [], 'ghosts': []})

    def test_scheduled_hop_times_are_distinct_from_vehicle_estimates(self):
        feeds = self.feeds()
        rows = [{'RouteStopID': 94, 'VehicleEstimates': [{'OnRoute': True, 'SecondsToStop': 90, 'VehicleID': 3}], 'ScheduledTimes': [{'ArrivalTimeUTC': f'/Date({(self.now+300)*1000})/'}]}]
        live = self.poll(feeds, rows)
        self.assertEqual(live['hop_stops']['94'][0][2:], [False, 3])
        self.assertEqual(live['hop_stops']['94'][1][2:], [True, None])

    def test_failure_of_vehicle_feed_preserves_arrivals(self):
        feeds = self.feeds()
        e = feeds['trips'].entity.add(); e.id = 'trip'
        tu = e.trip_update; tu.trip.trip_id = 'abc'; tu.trip.route_id = '14'
        u = tu.stop_time_update.add(); u.stop_id = '5'; u.departure.time = self.now+60
        feeds['vehicles'] = OSError('source unavailable')
        live = self.poll(feeds)
        self.assertFalse(live['sources']['vehicles']['ok'])
        self.assertEqual(live['stops']['5'][0][3], 'abc')
        self.assertEqual(live['vehicles'], [])

    def test_canceled_skipped_and_departed_stops_are_not_predictions(self):
        feeds = self.feeds()
        e = feeds['trips'].entity.add(); e.id = 'canceled'
        e.trip_update.trip.trip_id = 'cancel'; e.trip_update.trip.start_date = '20261016'
        e.trip_update.trip.schedule_relationship = gtfs.TripDescriptor.CANCELED
        e = feeds['trips'].entity.add(); e.id = 'trip'
        tu = e.trip_update; tu.trip.trip_id = 'abc'; tu.trip.route_id = '14'; tu.trip.start_date = '20261016'
        u = tu.stop_time_update.add(); u.stop_id = 'skip'; u.schedule_relationship = gtfs.TripUpdate.StopTimeUpdate.SKIPPED; u.arrival.time = self.now+60
        u = tu.stop_time_update.add(); u.stop_id = 'past'; u.arrival.time = self.now-90
        u = tu.stop_time_update.add(); u.stop_id = 'next'; u.departure.time = self.now+120
        live = self.poll(feeds)
        self.assertIn('cancel|20261016', live['canceled'])
        self.assertEqual(live['skipped']['skip'], ['abc|20261016'])
        self.assertEqual(live['passed']['past'], ['abc|20261016'])
        self.assertEqual(set(live['stops']), {'next'})

    def test_old_vehicle_report_is_excluded(self):
        feeds = self.feeds()
        e = feeds['vehicles'].entity.add(); e.id = 'old'
        v = e.vehicle; v.timestamp = self.now-181; v.vehicle.id = '1'
        v.position.latitude = 43.0; v.position.longitude = -87.9
        self.assertEqual(self.poll(feeds)['vehicles'], [])

    def test_active_periods_filter_future_alert_and_keep_boarding_details(self):
        feeds = self.feeds()
        for name, start in [('future', self.now+1000), ('current', self.now-1000)]:
            e = feeds['alerts'].entity.add(); e.id = name
            a = e.alert; a.header_text.translation.add(text=name, language='en')
            a.description_text.translation.add(text='Inactive Stop IDs: 5, 63. Board at Wisconsin.', language='en')
            a.active_period.add(start=start)
        alerts = self.poll(feeds)['alerts']
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]['title'], 'current')
        self.assertIn('5, 63', alerts[0]['text'])

if __name__ == '__main__': unittest.main()
